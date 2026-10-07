# HOP Chat on a VM shared with other services

HOP Chat runs behind the VM's existing reverse proxy (Caddy, or another app's
nginx) and publishes no port of its own. The proxy itself, the shared Docker
network and the scripts that start and stop everything on the VM belong to
the VM, not to HOP Chat, and are set up outside this repository. This page
covers only HOP Chat's side.

| File | What it is |
|---|---|
| `docker-compose.override.yml` | Layered on the repo's `docker-compose.yml`: no published port, joins the proxy's network (`edge`, or `HOP_CHAT_PROXY_NETWORK`) as `hop-chat`, memory caps, log rotation. |
| `nginx-hop-chat.conf` | Server blocks for when the entry point is an nginx rather than Caddy. |

HOP Chat uses about 100 MB at runtime and is capped at 512 MB (backend) +
128 MB (nginx).

## Requirements

- Docker Engine with the Compose plugin **2.24 or later** (the override uses `!reset`).
- A reverse proxy on the VM that terminates TLS and sits on a Docker network
  HOP Chat can join (`edge` by default).
- A hostname of its own for HOP Chat (e.g. `chat.example.com`), with DNS
  pointing at the VM. It must be a (sub)domain, not a path: the app serves
  `/api`, `/c/`, `/a/`, `/embed/`, `/widget/` and the admin UI from the root.

## Setup

**1. Configure HOP Chat.** Create the repo-root `.env` (don't copy
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

`PUBLIC_BASE_URL` must be exactly the HOP Chat site's origin. If the proxy's
network is not `edge`, add `HOP_CHAT_PROXY_NETWORK=<that network>`. For
production, add hop-core's SSO settings (`SSO_ONLY=true`, a Google and/or
Microsoft client, `ALLOWED_EMAIL_DOMAINS`), listed in the repo's `.env.example`.
Leave `COOKIE_DOMAIN` unset, so the login cookies stay on HOP Chat's own host
and can't collide with another app's (which matters if another one is also a
hop-core app).

Back up `ENCRYPTION_KEY` outside the VM (e.g. Secret Manager). Without it,
every stored API key and Deploy token is unreadable.

**2. Start HOP Chat** from the repo root:

```bash
docker compose -f docker-compose.yml -f deploy/shared-vm/docker-compose.override.yml up -d --build
```

Use the same two `-f` flags for every later command (`ps`, `logs`, `down`,
`pull`). Otherwise Compose reverts to the standalone layout and publishes port 8080.
The services are `hop-chat-backend` and `hop-chat-web` (e.g. `logs -f hop-chat-backend`).
Only `hop-chat-web` joins the proxy's network, under the alias `hop-chat`.

**3. Route the hostname to it** in the proxy (below), then reload the proxy.

**4. Check** `https://chat.example.com/api/health` → `{"status":"ok"}`, then
open `https://chat.example.com/` to register the first account.

## Behind Caddy

HOP Chat's site block:

```caddy
chat.example.com {
	reverse_proxy hop-chat:80

	header {
		Strict-Transport-Security "max-age=31536000"
		-Server
	}
}
```

Caddy streams the chat's server-sent events as they arrive and has no response
timeout, so long answers are not cut off. **Don't add `encode`** (compression)
to this block: the responses are small and compressing only risks buffering
the streams.

## Behind an existing nginx

If another app's nginx owns 80/443 (for example, with certbot on the host),
HOP Chat can sit behind it. That nginx needs no restart and its app is not
interrupted.

1. **Find its network**:
   `docker inspect <nginx-container> --format '{{range $n, $_ := .NetworkSettings.Networks}}{{$n}} {{end}}'`.
   Put it in the repo-root `.env` as `HOP_CHAT_PROXY_NETWORK=<that network>`.
2. **Point DNS** for HOP Chat's subdomain at the VM. The certificate challenge
   needs it, and the other nginx's port-80 server must answer
   `/.well-known/acme-challenge/` for any host (the usual certbot setup).
3. **Issue the certificate** the way that nginx's existing ones were. Check
   `/etc/letsencrypt/renewal/*.conf` for `authenticator` and `webroot_path`,
   e.g. `sudo certbot certonly --webroot -w <webroot_path> -d chat.example.com`.
4. **Start HOP Chat** with the override (Setup, step 2).
5. **Add `nginx-hop-chat.conf`** (with your hostname) to that nginx's
   configuration: a new file in its `conf.d` if that directory is mounted from
   the host, otherwise append it to the mounted config file. Then run
   `docker exec <nginx-container> nginx -t && docker exec <nginx-container> nginx -s reload`.

The server blocks resolve `hop-chat` per request, so if HOP Chat is down only
its subdomain fails. The other nginx still starts and reloads normally. They
also turn off response buffering so streamed answers arrive as they are
written, and send no `X-Frame-Options`, because the chat must be embeddable.

## Things worth knowing

- **Unique service names.** Compose registers each service under its service
  name on every network it joins, so two apps that both have a `frontend`
  service make `frontend` resolve to both, at random. That is why HOP Chat's
  services are `hop-chat-backend` and `hop-chat-web`; keep them unique.
- **Visitor IPs.** The per-IP rate limits key on the address the proxy passes
  on. The app's nginx trusts `X-Forwarded-For` / `X-Forwarded-Proto` only from
  a proxy on a private network, so visitors cannot spoof them. If the proxy's
  logs show a `172.x` address for every request, Docker's userland proxy is in
  the path; add `"userland-proxy": false` to `/etc/docker/daemon.json`.
- **Building on the VM** briefly needs about 1.4 GB for the Angular build.
- **Backups**: snapshot the VM's disk to cover the `chat-data` volume (HOP
  Chat's SQLite). HOP Chat runs as a single replica by design; scale the VM
  up, not out.
- **Don't rename the project.** The override deliberately sets no `name:`.
  Changing the Compose project name renames the data volume, and HOP Chat
  would start on an empty database.
