# HOP Chat — agent notes

Built on [hop-core](https://github.com/Heretto/hop-core), pinned at **v0.1.6**
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
  `embed.js` (launcher bubble in a shadow root, and the iframe), `chat.js` and
  `chat.css` (the chat page at `/c/{public_id}`).

## What is specific to this project

- **Settings**: `backend/.env` for a local uvicorn (read relative to
  `backend/app/settings.py`), and the repo-root `.env` for Docker Compose.
  Template: `.env.example`. `PUBLIC_BASE_URL` must be the origin browsers use —
  embed snippets and chat URLs are built from it.
- **Start the stack locally**: `./dev.sh` (modelled on hop-core's `demo/run.sh`):
  it installs on first run, generates `backend/.env` via `scripts/setup.sh`, and
  picks free ports. It writes a temporary ng proxy for `/api`, `/c`, `/embed`
  and `/widget`, and passes `PUBLIC_BASE_URL` for the chosen port so embed
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
  `/embed/` and `/widget/`. Without that, hop-core's CSRF middleware 403s every
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
