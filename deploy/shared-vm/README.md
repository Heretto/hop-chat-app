# HOP Chat on a VM shared with other services

One VM, several services, one entry point: **Caddy** owns ports 80/443,
gets and renews certificates automatically, and routes each hostname to one
service on a shared `edge` Docker network. HOP Chat publishes no port of its own.

```
              :443 / :80
                  │
             ┌────▼────┐   edge network
 internet ──▶│  Caddy  │──────────┬───────────────┬───────────────┐
             └─────────┘          │               │               │
                         hop-chat (nginx)   service-two     service-three
                                  │
                         backend (uvicorn) ── SQLite volume
```

| File | What it is |
|---|---|
| `docker-compose.proxy.yml` | The Caddy stack (Compose project `edge`). Creates the `edge` network. |
| `Caddyfile` | One site block per service. HOP Chat's is filled in; two placeholders for yours. |
| `.env.example` | `ACME_EMAIL` and the hostnames Caddy serves. |
| `docker-compose.override.yml` | Layered on the repo's `docker-compose.yml`: no published port, joins the proxy's network (`edge`, or `HOP_CHAT_PROXY_NETWORK`) as `hop-chat`, memory caps, log rotation. |
| `nginx-hop-chat.conf` | Server blocks for when another app's nginx is already the entry point instead of Caddy (see below). |

Sized for an e2-standard-2 (2 vCPU, 8 GB) shared three ways: HOP Chat uses
about 100 MB at runtime and is capped at 512 MB (backend) + 128 MB (nginx).

## Requirements

- Docker Engine with the Compose plugin **2.24 or later** (the override uses `!reset`).
- A DNS A (and AAAA, if the VM has IPv6) record per hostname, pointing at the VM.
- VPC firewall: allow TCP 80 and 443 (and UDP 443 for HTTP/3) to the VM.
  Port 80 must stay open: Let's Encrypt uses it to issue certificates, and Caddy
  uses it to redirect to HTTPS.

## Setup

**1. Docker log rotation** for every container on the VM. Without it, Docker's
default log driver grows until the disk is full. `/etc/docker/daemon.json`:

```json
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }
```

then `sudo systemctl restart docker`. This applies to containers created
afterwards. The compose files here also set it for their own containers.

**2. Start Caddy** from a directory of its own: the proxy belongs to the VM,
not to HOP Chat or any other app.

```bash
docker network create edge                       # once per VM
mkdir -p ~/edge && cp deploy/shared-vm/{docker-compose.proxy.yml,Caddyfile,.env.example} ~/edge/
cd ~/edge
cp .env.example .env        # set ACME_EMAIL and HOP_CHAT_HOST
docker compose -f docker-compose.proxy.yml up -d
```

Keep `~/edge` (its `Caddyfile` especially) under version control or in your
backups: it's the VM's routing table.

**3. Configure HOP Chat.** Create the repo-root `.env` (don't copy
`.env.example`: its `DATABASE_URL` is for running without Docker and would put
the database inside the container, where a rebuild loses it):

```bash
cat > .env <<EOF
APP_SECRET_KEY=$(openssl rand -hex 32)
JWT_SECRET_KEY=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)
PUBLIC_BASE_URL=https://chat.example.com
COOKIE_SECURE=true
EOF
chmod 600 .env
```

`PUBLIC_BASE_URL` must be exactly the HOP Chat site's origin.

Back up `ENCRYPTION_KEY` outside the VM (e.g. Secret Manager). Without it,
every stored API key and Deploy token is unreadable.

**4. Start HOP Chat** from the repo root:

```bash
docker compose -f docker-compose.yml -f deploy/shared-vm/docker-compose.override.yml up -d --build
```

Use the same two `-f` flags for every later command (`ps`, `logs`, `down`,
`pull`). Otherwise Compose reverts to the standalone layout and publishes port 8080.
The services are `hop-chat-backend` and `hop-chat-web` (e.g. `logs -f hop-chat-backend`).

**5. Check** `https://chat.example.com/api/health` → `{"status":"ok"}`, then
open `https://chat.example.com/` to register the first account.

## Adding your other two services

Each service joins `edge` under an alias, publishes no ports, and gets a site
block in the Caddyfile. **Every container on a shared network needs a name no
other app uses.** Compose registers each service under its service name on
every network it joins, so two apps that both have a `frontend` service make
`frontend` resolve to both, at random. HOP Chat's services are called
`hop-chat-backend` and `hop-chat-web` for this reason. Have the proxy use a
unique alias, and put only the container the proxy talks to on the shared
network. In that service's own compose file:

```yaml
services:
  web:                       # whichever container serves HTTP
    networks:
      default:
      edge:
        aliases: [service-two]
    # no `ports:` — Caddy is the way in

networks:
  edge:
    external: true
```

Uncomment and adjust its block in the `Caddyfile` (`reverse_proxy service-two:8000`
— the alias and the port the container listens on), add its hostname to
`.env`, and reload Caddy without downtime:

```bash
docker compose -f docker-compose.proxy.yml exec caddy caddy reload --config /etc/caddy/Caddyfile
```

Keep each service on its own hostname, and leave HOP Chat's `COOKIE_DOMAIN`
unset. Its login cookies then stay on its own host and can't collide with
another app's, which matters if one of the others is also a hop-core app.

## Moving an existing app behind Caddy

An app that terminates TLS itself (its own nginx with certbot, publishing
80/443) moves behind Caddy with three changes to its proxy, or Caddy and it
will fight:

1. **Plain HTTP only.** Serve the app's routing on port 80 with no redirect
   to HTTPS. Caddy talks HTTP to it, so an HTTP→HTTPS redirect there loops
   forever. Drop its `ssl` server, certificates and ACME location.
2. **Believe Caddy about the visitor.** With nginx, set
   `set_real_ip_from` the private ranges plus `real_ip_header X-Forwarded-For`.
   Otherwise every request comes from Caddy's address, and per-IP rate limits
   (`limit_req_zone $binary_remote_addr`) throttle all visitors as one.
   Pass `X-Forwarded-Proto` through from Caddy instead of `$scheme`, or the
   app thinks it is served over HTTP.
3. **No published ports; join `edge`** with a unique alias, and give it a site
   block in the Caddyfile.

`examples/release-notes-nginx.conf` is a worked example: the Release Notes
Agent's nginx after the move.

Expect a minute of downtime for that app while its proxy is recreated and
Caddy gets certificates (port 80 must be free before Caddy starts).

## Behind an existing nginx (instead of Caddy)

If another app's nginx already owns 80/443 (for example, it terminates TLS
for that app, with certbot on the host), HOP Chat can sit behind it instead of
adding Caddy. That nginx needs no restart and its app is not interrupted.

1. **Find its network**:
   `docker inspect <nginx-container> --format '{{range $n, $_ := .NetworkSettings.Networks}}{{$n}} {{end}}'`.
   Put it in the repo-root `.env` as `HOP_CHAT_PROXY_NETWORK=<that network>`.
   Only `hop-chat-web` joins it, as `hop-chat`.
2. **Point DNS** for HOP Chat's subdomain at the VM. The certificate challenge
   needs it, and the other nginx's port-80 server must answer
   `/.well-known/acme-challenge/` for any host (the usual certbot setup).
3. **Issue the certificate** the way that nginx's existing ones were. Check
   `/etc/letsencrypt/renewal/*.conf` for `authenticator` and `webroot_path`,
   e.g. `sudo certbot certonly --webroot -w <webroot_path> -d chat.example.com`.
4. **Start HOP Chat** with the override (as in Setup, step 4), but skip Caddy
   (Setup, step 2).
5. **Add `nginx-hop-chat.conf`** (with your hostname) to that nginx's
   configuration: a new file in its `conf.d` if that directory is mounted from
   the host, otherwise append it to the mounted config file. Then run
   `docker exec <nginx-container> nginx -t && docker exec <nginx-container> nginx -s reload`.

The server blocks resolve `hop-chat` per request, so if HOP Chat is down only
its subdomain fails. The other nginx still starts and reloads normally. They
also turn off response buffering so streamed answers arrive as they are
written, and send no `X-Frame-Options`, because the chat must be embeddable.

## Things worth knowing

- **Streaming answers pass straight through.** Caddy forwards server-sent
  events as they arrive and has no response timeout. Don't add `encode`
  (compression) to the HOP Chat block.
- **Visitor IPs.** The per-IP rate limits key on the address Caddy sees. The
  app's nginx trusts forwarding headers only from a proxy on a private network,
  so visitors cannot spoof them. Check `docker compose -f docker-compose.proxy.yml
  logs caddy`: `remote_ip` should show real public addresses. If every request
  shows a `172.x` address, Docker's userland proxy is in the path (it can be
  with IPv6 publishing); add `"userland-proxy": false` to `daemon.json`.
- **Building on the VM** briefly needs about 1.4 GB for the Angular build.
  Don't rebuild all three services at once.
- **Backups**: a snapshot schedule on the VM's disk covers the `chat-data`
  volume (HOP Chat's SQLite) and `caddy-data` (certificates). HOP Chat runs
  as a single replica by design; scale the VM up, not out.
- **Don't rename the project.** The override deliberately sets no `name:`.
  Changing the Compose project name renames the data volume, and HOP Chat
  would start on an empty database.
