# HOP Chat — agent notes

Built on [hop-core](https://github.com/Heretto/hop-core), pinned at **v0.1.10**
(`backend/requirements.txt` and the `@heretto/hop-ui` asset URL in
`frontend/package.json` — always bump them together).

## Before changing anything

Run `hop-doctor` from the repo root (installed with hop-core into the backend
venv: `backend/.venv/bin/hop-doctor`). It audits this project's hop-core
integration and exits non-zero on real problems.

## hop-core references — a different repository, not loaded here

- Integration rules, failure modes, upgrade steps: hop-core `AGENTS.md`
- Design system, components, tokens, app skeleton: hop-core `DESIGN-SYSTEM.md`

Read those instead of inferring from this project's code. Do not copy them here.

## What this app is

An embeddable documentation chat. The domain model, and which layer owns what:

| Thing | Owned by | Notes |
|---|---|---|
| AI configuration (provider, model, key) | hop-core credential (`anthropic`/`openai`/`gemini`) | selected by an agent |
| **Agent** (instructions, context files, reference URLs, memory) | hop-core `/agents` + `HOP_AGENT_ROUTES` UI | **the only place the AI is configured** |
| Deploy deployment (org, deployment, token, portal URL, audience) | hop-core credential of type `heretto_deploy`, registered in `app/deploy/credential.py` | has a Test button |
| **Chat app** (agent + deploy credential + appearance + allowed origins + public URL) | this app, `app/models.py` → `/api/v1/chat-apps/` | one per website/app |
| Conversations + messages (retained transcripts) | this app | visitor = sha256 of a browser-held token |

- `backend/app/chat/service.py` — builds the prompt from
  `AgentDefinition.build_system_prompt()` plus the Deploy guidance, and runs it.
- `backend/app/chat/engine.py` — our own tool-calling loop per provider.
  hop-core's `CredentialAiService.generate_with_tools` only knows its fixed
  `read_url` tool, so it cannot carry the Deploy tools. The loops mirror
  `hop_core.agents.providers` (same endpoints and error style); keep them in
  step when hop-core's change.
- `backend/app/deploy/` — Deploy v4 client and tools. We call the API directly
  rather than running `heretto-deploy-mcp`, because that server is configured
  per *process* from env vars (one token/deployment) and its HTTP mode has no
  auth. Tool descriptions and answering guidance are ported from it. The v4
  OpenAPI spec lives in that repo (`deploy-api-v4-openapi-spec.json`).
- `backend/app/widget/static/` — visitor UI, plain JS with no build step:
  `common.js` (visitor token, API/SSE, safe Markdown, DOM helpers; loaded
  first by both pages), `embed.js` (chat launcher bubble in a shadow root, and
  the iframe), `chat.js`/`chat.css` (the chat page at `/c/{public_id}`), and
  `search-embed.js` (the search-answers loader), `answer.js`/`answer.css` (the
  search-answers panel at `/a/{public_id}`).
- **Search answers** (`app/chat/search.py`, `POST /public/chat/{id}/search`):
  the first reply to a portal search. `looks_like_question` skips keyword
  searches without a model call. Otherwise the agent gets `SEARCH_GUIDANCE`
  and must open its reply with `[ANSWER]`, `[CLARIFY]` (plus up to four `- `
  options) or `[NOT_A_QUESTION]`, which `parse_reply` turns into what the
  panel shows. "Not a question" deletes the conversation again. Later turns
  use the ordinary `/messages` route, so they are a normal chat. Clarifying
  options are stored in `details.options` and put back into the model's
  history as bullets. The settings live in `chat_app_search_widgets` (a
  separate table, so `create_all` adds it to existing databases without a
  migration).

## What is specific to this project

- **Settings**: `backend/.env` for a local uvicorn (read relative to
  `backend/app/settings.py`), and the repo-root `.env` for Docker Compose.
  Template: `.env.example`. `PUBLIC_BASE_URL` must be the origin browsers use —
  embed snippets and chat URLs are built from it.
- **Start the stack locally**: `./dev.sh` (modelled on hop-core's `demo/run.sh`):
  it installs on first run, generates `backend/.env` via `scripts/setup.sh`, and
  picks free ports. It writes a temporary ng proxy for `/api/`, `/c/`, `/a/`,
  `/embed/` and `/widget/`, and passes `PUBLIC_BASE_URL` for the chosen port so embed
  snippets are right. The proxy file must end in `.json`, because ng picks the
  format from the extension. The backend runs without `--reload` unless asked:
  uvicorn's reloader outlives an app that fails to start, which would hide the
  crash until the timeout. Or run `docker compose up --build` for everything
  on :8080 behind nginx.
- **Tests**: `make test` runs pytest (all upstream HTTP is mocked; no keys
  needed) plus the widget's jsdom test (`backend/tests/widget_js`).
- **One origin, and cookies on visitor paths.** The admin UI and the visitor
  chat share an origin, so an operator's `access_token` cookie reaches the
  public API. `app/middleware.py` strips cookies on `/api/v1/public/`, `/c/`,
  `/a/`, `/embed/` and `/widget/`. Without that, hop-core's CSRF middleware 403s every
  visitor POST from a signed-in operator's browser, and the Test tab breaks.
- **Framing.** hop-core sends `X-Frame-Options: DENY` on everything. The chat
  page is meant to be framed, so it sends `X-Hop-Frameable` and the middleware
  drops both headers. `frame-ancestors` comes from the chat app's allowed
  origins; an empty list means any site can frame it.
- **Streaming.** Visitor messages return server-sent events. The reply runs in
  its own task with its own DB session, so it is stored even if the visitor
  leaves. nginx needs `proxy_buffering off` for `/api/` (set in
  `frontend/nginx.conf`).
- **Test tab agent log.** `POST /chat-apps/{id}/test-session` issues a signed,
  8-hour trace token (`app/trace.py`) bound to that chat app. The Test tab loads
  the chat with `?trace=…`, and the chat page sends it back as `X-Hop-Trace`.
  Only then does the reply stream interleave `trace` events: model calls and
  decisions, tool calls with result summaries, timings, tokens, and operator
  error text. The page forwards them with `postMessage` to its same-origin
  parent. `AgentLogComponent` folds them into turns, and the editor accepts
  messages only from its own iframe. Add new event types in
  `engine.py`/`service.py` and render them in `build()` in `agent-log.component.ts`.
- **Single replica.** In-flight replies are in-process tasks and the slowapi
  rate limiter is in memory. Scale vertically, or move both out of process first.
- **SQLite**, created by hop-core's startup `create_all` — our tables register
  because `app/main.py` imports `app.models`. There is no Alembic yet. Adding a
  column to an existing table needs a migration; set one up per hop-core
  `AGENTS.md` §6 before the first schema change ships.
- On some mounted filesystems (e.g. a sandbox's host mount), SQLite fails with
  "attempt to write a readonly database". Point `DATABASE_URL` at a local path.
- Angular 22 needs Node ≥ 22.22.3 or ≥ 24.15.
- **Forwarding headers.** `frontend/nginx.conf` believes `X-Forwarded-For` /
  `X-Forwarded-Proto` only from a proxy on a private network (the VM's
  reverse proxy in `deploy/shared-vm/`). It passes the backend a single client address, never a
  chain, because uvicorn (`--forwarded-allow-ips "*"`) takes the first entry,
  and an appended chain would let visitors spoof their IP past the rate limits.
- **Shared-VM deployment** (`deploy/shared-vm/`): an override for the main
  compose file (`!reset` drops the published port; needs Compose ≥ 2.24) that
  joins the VM's proxy network, `HOP_CHAT_PROXY_NETWORK` (default `edge`), as
  `hop-chat`. Behind Caddy or another app's nginx (`nginx-hop-chat.conf`). The
  proxy, the `edge` network and VM-wide start/stop scripts are not part of this
  repo. The override must not set `name:`: renaming the project renames the
  `chat-data` volume.
- **Accounts are hop-core's.** This app adds no sign-up or sign-in logic, and
  nothing in it creates users (the visitor API is anonymous). `docker-compose.yml`
  only passes hop-core's settings through (`SSO_ONLY`, OAuth clients,
  `OAUTH_REDIRECT_BASE_URL`, `ALLOWED_EMAIL_DOMAINS`, `SINGLE_ORG_*`); unset
  ones arrive as empty strings, which hop-core treats as unset.
  `OAUTH_REDIRECT_BASE_URL` defaults to `PUBLIC_BASE_URL`, so the Microsoft
  callback is right behind a proxy. `tests/test_sso_only.py` checks nothing
  here opens a password path around `SSO_ONLY`.
- **Compose service names must stay unique** (`hop-chat-backend`,
  `hop-chat-web`). Compose registers each service name on every network the
  service joins, so on a network shared with another app, a plain
  `frontend`/`backend` resolves to both apps' containers. Verified: another
  app's nginx would then send part of its traffic to HOP Chat.
- **Visitor path prefixes need their trailing slash** in every proxy (the ng
  proxy files and `frontend/nginx.conf`): a bare `/c` also catches the admin's
  `/chat-apps`, and a bare `/a` would catch `/agents`, `/account` and `/admin`.
- **Cards get their padding from `<mat-card-content>`.** The hop-core theme
  leaves `mat-card` itself at zero padding, so put card bodies in
  `<mat-card-content>` rather than adding padding per component. A card that is
  deliberately edge-to-edge (a list with its own row padding) takes hop-core's
  `no-pad` class.

## Upgrading hop-core

Resolve the current release (hop-core `AGENTS.md`, Step 0), bump the Python
requirement and the `@heretto/hop-ui` asset URL **together**, regenerate the
npm lock, rebuild, then re-run `hop-doctor` and `make test`. Check whether
`hop_core.agents.providers` gained support for arbitrary tools. If it did,
`app/chat/engine.py` can be replaced by it.
