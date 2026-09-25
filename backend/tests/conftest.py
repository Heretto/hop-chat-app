"""Test fixtures: a real app on a throwaway SQLite file, with outbound HTTP mocked.

Every external call — the AI provider and the Deploy API — goes through
``FakeUpstream``, so the suite needs no keys and no network.
"""

import json
import os
import tempfile
import uuid

import httpx
import pytest

_DB = os.path.join(tempfile.mkdtemp(prefix="hop-chat-test-"), "test.db")
os.environ.update(
    APP_ENV="test",
    APP_SECRET_KEY="test-app-secret-key-for-unit-tests-000000",
    JWT_SECRET_KEY="test-jwt-secret-key-for-unit-tests-0000000",
    ENCRYPTION_KEY="test-encryption-key-for-tests-000000",
    DATABASE_URL=f"sqlite:///{_DB}",
    FRONTEND_BASE_URL="http://chat.test",
    PUBLIC_MESSAGE_RATE_LIMIT="1000/minute",
)

from starlette.testclient import TestClient  # noqa: E402

from app.main import app as _app  # noqa: E402


@pytest.fixture(scope="session")
def client():
    with TestClient(_app) as c:
        yield c


@pytest.fixture(autouse=True)
def _isolate(client):
    from hop_core.core.rate_limit import limiter

    limiter.reset()
    yield
    client.cookies.clear()


class FakeUpstream:
    """Scripted responses for the AI provider and the Deploy API.

    ``ai_replies`` are consumed in order, one per model call. Deploy calls are
    answered from ``deploy`` keyed by path suffix. Every request is recorded.
    """

    def __init__(self):
        self.ai_replies = []
        self.deploy = {}
        self.requests = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        host = request.url.host
        if host == "api.anthropic.com":
            if not self.ai_replies:
                return httpx.Response(500, json={"error": {"message": "no scripted reply"}})
            return httpx.Response(200, json=self.ai_replies.pop(0))
        if host.endswith(".deploy.heretto.com"):
            path = request.url.path.split("/deployments/", 1)[1].split("/", 1)
            suffix = "/" + path[1] if len(path) > 1 else ""
            status, body = self.deploy.get(suffix, (404, {}))
            return httpx.Response(status, json=body)
        return httpx.Response(599, text=f"unexpected host {host}")

    def bodies(self, host: str):
        return [json.loads(r.content) for r in self.requests if r.url.host == host and r.content]


@pytest.fixture
def upstream(monkeypatch):
    fake = FakeUpstream()
    transport = httpx.MockTransport(fake.handler)

    import app.chat.engine as engine
    from app.deploy.client import DeployClient

    monkeypatch.setattr(
        engine, "_client",
        lambda: httpx.AsyncClient(transport=transport, follow_redirects=False),
    )
    original = DeployClient.__init__

    def patched(self, config, transport_=None, **kwargs):
        original(self, config, transport=transport)

    monkeypatch.setattr(DeployClient, "__init__", patched)
    return fake


# ── helpers ───────────────────────────────────────────────────────────────────

def unique(prefix: str) -> str:
    return f"{prefix} {uuid.uuid4().hex[:6]}"


def register_user(client) -> dict:
    email = f"test-{uuid.uuid4().hex[:8]}@example.com"
    resp = client.post("/api/v1/auth/register", json={"email": email, "password": "SecurePass123!"})
    assert resp.status_code == 200, resp.text
    resp = client.post("/api/v1/auth/login", json={"email": email, "password": "SecurePass123!"})
    assert resp.status_code == 200, resp.text
    token = resp.json()["access_token"]
    client.cookies.clear()
    return {"email": email, "headers": {"Authorization": f"Bearer {token}"}, "token": token}


@pytest.fixture
def operator(client):
    return register_user(client)


@pytest.fixture
def configured(client, operator):
    """An org with an AI configuration, an agent on it, a Deploy credential and a chat app."""
    h = operator["headers"]
    ai = client.post("/api/v1/credentials", headers=h, json={
        "type": "anthropic", "name": unique("Claude"),
        "credentials": {"api_key": "sk-ant-test-key-000000", "model": "claude-sonnet-5"},
    })
    assert ai.status_code in (200, 201), ai.text
    agent = client.post("/api/v1/agents", headers=h, json={
        "name": unique("Docs Agent"),
        "description": "Help customers use the product.",
        "ai_configuration_id": ai.json()["id"],
        "context_files": [{"name": "tone.md", "content": "Be friendly and brief."}],
    })
    assert agent.status_code in (200, 201), agent.text
    deploy = client.post("/api/v1/credentials", headers=h, json={
        "type": "heretto_deploy", "name": unique("Docs site"),
        "credentials": {
            "organization_id": "acme", "deployment_id": "docs",
            "token": "deploy-token-000000", "portal_base_url": "https://docs.acme.com",
        },
    })
    assert deploy.status_code in (200, 201), deploy.text
    app_resp = client.post("/api/v1/chat-apps/", headers=h, json={
        "name": unique("Website chat"),
        "agent_id": agent.json()["id"],
        "deploy_credential_id": deploy.json()["id"],
        "appearance": {"title": "Acme Help", "suggested_prompts": ["How do I start?"]},
        "allowed_origins": ["https://www.acme.com"],
    })
    assert app_resp.status_code == 201, app_resp.text
    return {
        "operator": operator,
        "ai": ai.json(),
        "agent": agent.json(),
        "deploy": deploy.json(),
        "chat_app": app_resp.json(),
    }


def visitor_headers(token: str = None) -> dict:
    return {"X-Visitor-Token": token or ("v" + uuid.uuid4().hex + uuid.uuid4().hex)[:48]}


def sse_events(text: str):
    events = []
    for block in text.split("\n\n"):
        event, data = None, ""
        for line in block.splitlines():
            if line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:"):
                data += line[5:].strip()
        if event:
            events.append((event, json.loads(data)))
    return events
