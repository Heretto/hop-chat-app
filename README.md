# HOP Chat

An embeddable chat widget that answers visitors' questions from your published
Heretto content, through the [Heretto Deploy API](https://help.heretto.com/en/heretto-deploy-api/deploy-api-overview).
Built on [hop-core](https://github.com/Heretto/hop-core): auth, organizations,
encrypted credentials and the **Agent** pattern come from hop-core, so the AI
behind every chat is configured as a standard hop-core agent.

```
 Website / web app                         HOP Chat
 ┌───────────────────────────┐            ┌──────────────────────────────────────────┐
 │ <script src=".../embed/   │  iframe    │  /c/{id}   chat page (plain JS)          │
 │   {id}.js" async>         │──────────▶│     │                                     │
 │           ( 💬 )           │            │     ▼ /api/v1/public/chat/{id}/… (SSE)   │
 └───────────────────────────┘            │  Chat app ──▶ hop-core Agent             │
                                          │     │           ├─ AI configuration ──▶ Claude / GPT / Gemini
                                          │     │           ├─ context files, memory │
                                          │     └─▶ Heretto Deploy credential ──▶ Deploy v4 API
                                          │          (search, read topic, TOC)       │
                                          └──────────────────────────────────────────┘
```

## Concepts

| | What it is | Where you manage it |
|---|---|---|
| **AI configuration** | A provider API key and model (Anthropic, OpenAI or Gemini) | Credentials → AI Providers |
| **Agent** | A standard hop-core agent: AI configuration, description (its instructions), context files (style guide, tone, product background), reference URLs, feedback memory | Agents |
| **Heretto Deploy credential** | Organization ID, deployment ID, Deploy API token, portal URL, and an optional audience that restricts what the chat can see | Credentials → Heretto Deploy |
| **Chat app** | One agent + one deployment + appearance + where it may be embedded. It gets its own URL and embed snippet | Chat Apps |

For a new website or app, create an agent (or reuse one), then create a chat
app that uses it. Several chat apps can share an agent and a deployment.

### What visitors get

- A chat bubble that opens a chat window. On phones the window goes full screen.
- Answers grounded in the deployment. The assistant searches, reads the relevant
  topics, and links them as sources. It says so when the docs don't cover
  something.
- Live progress while it works ("Searching the docs for …").
- **Previous conversations**: transcripts are kept, and a visitor can reopen or
  delete them from the history view. There is no account. Identity is a random
  token in the browser's local storage, and the server stores only its hash.
- Answers in the visitor's language when translations are published. The
  browser language is sent to Deploy as `Accept-Language`.

### What operators get

- The **Conversations** tab on each chat app shows every transcript: the page
  it started on, the language, the sources behind each answer, and a trace of
  the model and tool calls. Provider and Deploy errors are recorded there,
  while the visitor only sees a gentle apology.
- A **Test** tab that runs the live chat inside the admin UI.
- The agent's own **Test** tab (from hop-core) for tuning its instructions.

## Embedding

```html
<script src="https://chat.example.com/embed/AbC123xyz_9Q.js" async></script>
```

The script draws the launcher inside a shadow root, so the host page's CSS
and the chat's CSS don't affect each other. On first open it loads the chat in
an iframe. The host page can drive it:

```js
HopChat.open(); HopChat.close(); HopChat.toggle();
HopChat.apps['AbC123xyz_9Q'].open();   // with several chats on one page
```

`https://chat.example.com/c/AbC123xyz_9Q` is the same chat as a full page.
Use it for links in emails, help menus, or a native app's web view.

If a site sends a Content-Security-Policy, it must allow the chat origin in
`script-src` and `frame-src`.

## Running it

Requirements: Python 3.11+, Node ≥ 22.22.3 or ≥ 24.15, `git`, `curl`.

```bash
./dev.sh
```

On first run it creates the backend venv (hop-core from its pinned release
tag), installs the npm packages, and writes `backend/.env` with fresh secrets.
Then it starts the API and the admin UI on free ports (from 8000 and 4200) and
opens the browser. Later runs reinstall only when `requirements*.txt` or
`package-lock.json` change. Ctrl+C stops everything.

| | |
|---|---|
| `./dev.sh --install` | install/refresh dependencies only |
| `./dev.sh --no-open` | don't open a browser |
| `./dev.sh --reload` | restart the backend on code changes |
| `BACKEND_PORT=9000 FRONTEND_PORT=5200 ./dev.sh` | start the port search elsewhere |

`make dev`, `make install` and `make env` call the same scripts.

Register at http://localhost:4200, then:

1. **Credentials → AI Providers**: add an Anthropic, OpenAI or Gemini key and a
   model. Use **Test** to check it.
2. **Credentials → Heretto Deploy**: add the org ID, deployment ID, token and
   portal URL. **Test** reads the deployment.
3. **Agents → New Agent**: pick the AI configuration. Give it a description
   ("Help customers of Acme Cloud with setup and troubleshooting…") and any
   context files, such as tone or escalation guidance.
4. **Chat Apps → New Chat App**: pick the agent and the Deploy credential, set
   the title and welcome message. Then copy the snippet from **Embed**.

### Docker

```bash
cp .env.example .env    # fill in the three secrets; set PUBLIC_BASE_URL
docker compose up --build   # http://localhost:8080
```

nginx serves the admin UI and proxies `/api`, `/c`, `/embed` and `/widget` to
the backend, all on one origin. Put TLS in front, set `PUBLIC_BASE_URL` to the
public `https://` origin and `COOKIE_SECURE=true`.

### Tests

```bash
make test        # pytest (upstreams mocked, no keys needed) + widget jsdom test
make doctor      # hop-core integration audit
```

## Security notes

- **Deploy and AI keys** are hop-core credentials, Fernet-encrypted at rest and
  never returned by the API. Back up `ENCRYPTION_KEY`: it cannot be rotated.
- **Audience scoping** in the Deploy credential applies to every call, so
  internal-only content cannot reach a public chat.
- **Transcripts are private to the browser that created them.** Every lookup
  is scoped to the chat app and the visitor-token hash.
- **Visitor paths ignore cookies**, so a signed-in operator's session is never
  used by or exposed to the chat.
- **Framing** is limited by CSP `frame-ancestors` to each chat app's allowed
  sites. An empty list means any site may embed it.
- **Rate limits**: visitor messages are limited per IP
  (`PUBLIC_MESSAGE_RATE_LIMIT`, default 20/minute), because each one is a paid
  model call. The limiter is in memory, so run one backend replica.
- Visitor messages and Deploy content go to the model as conversation and tool
  results. Tool output is framed as reference material rather than
  instructions. The agent's context files keep the authority hop-core gives them.
- **The Deploy organization ID** must be a bare hostname label, and redirects
  are never followed, so a credential cannot point requests at an arbitrary host.

See [`AGENTS.md`](AGENTS.md) for how the code is laid out and what was learned
building it.
