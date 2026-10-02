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
| `docker-compose.override.yml` | Layered on the repo's `docker-compose.yml`: no published port, joins `edge` as `hop-chat`, memory caps, log rotation. |

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

**2. Start Caddy:**

```bash
cd deploy/shared-vm
cp .env.example .env        # set ACME_EMAIL and HOP_CHAT_HOST
docker compose -f docker-compose.proxy.yml up -d
```

**3. Configure HOP Chat.** In the repo root, `cp .env.example .env` and set the
three secrets. Then set:

```env
PUBLIC_BASE_URL=https://chat.example.com   # exactly the HOP_CHAT_HOST origin
COOKIE_SECURE=true
```

Back up `ENCRYPTION_KEY` outside the VM (e.g. Secret Manager). Without it,
every stored API key and Deploy token is unreadable.

**4. Start HOP Chat** from the repo root:

```bash
docker compose -f docker-compose.yml -f deploy/shared-vm/docker-compose.override.yml up -d --build
```

Use the same two `-f` flags for every later command (`ps`, `logs`, `down`,
`pull`). Otherwise Compose reverts to the standalone layout and publishes port 8080.

**5. Check** `https://chat.example.com/api/health` → `{"status":"ok"}`, then
open `https://chat.example.com/` to register the first account.

## Adding your other two services

Each service joins `edge` under an alias, publishes no ports, and gets a site
block in the Caddyfile. In that service's own compose file:

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
