"""An agent's Heretto references reach the chat the way hop-core's runner sends them.

Style guides, information models and terminology are read up front and put in
the prompt; general content is offered through ``read_heretto``. The Heretto
CCMS itself is replaced by a fake reference source.
"""

import uuid

import app.chat.service as service
from hop_core.db import get_session_factory
from hop_core.models.agent import AgentReference

from tests.conftest import sse_events, visitor_headers
from tests.test_public_chat import _base, _script_docs, _text, _tool_use


class _Content:
    def __init__(self, text):
        self.text = text

    def as_prompt_text(self):
        return self.text


class _FakeSource:
    def __init__(self, files):
        self.files = files
        self.reads = []

    async def read(self, credential_id, file_id):
        self.reads.append(file_id)
        return _Content(self.files[file_id])


def _add_references(configured, *refs):
    db = get_session_factory()()
    try:
        for position, (file_id, reference_type) in enumerate(refs):
            db.add(AgentReference(
                agent_id=uuid.UUID(configured["agent"]["id"]),
                position=position,
                kind="heretto",
                # Any credential row will do: the fake source never decrypts it.
                credential_id=uuid.UUID(configured["ai"]["id"]),
                file_id=file_id,
                title=f"{file_id} title",
                reference_type=reference_type,
            ))
        db.commit()
    finally:
        db.close()


def test_heretto_references_are_included_and_readable(client, configured, upstream, monkeypatch):
    source = _FakeSource({"style": "Write in second person.", "notes": "Release 4 drops Python 3.9."})
    monkeypatch.setattr(service, "heretto_reference_source", lambda org_id, db: source)
    _add_references(configured, ("style", "style_guide"), ("notes", "general"))
    _script_docs(upstream)
    upstream.ai_replies = [_tool_use("read_heretto", {"reference_id": "missing"}), _text("Done.")]

    v = visitor_headers()
    base = _base(configured)
    cid = client.post(f"{base}/conversations", headers=v, json={}).json()["id"]
    events = sse_events(client.post(f"{base}/conversations/{cid}/messages", headers=v,
                                    json={"content": "What changed?"}).text)
    assert events[-1][0] == "message"

    first, second = upstream.bodies("api.anthropic.com")
    assert "Write in second person." in first["system"]
    assert "## Heretto content you can read" in first["system"]
    assert "read_heretto" in [t["name"] for t in first["tools"]]
    # Only listed references can be read.
    result = second["messages"][-1]["content"][0]["content"]
    assert result.startswith("No readable reference with id 'missing'")
    assert source.reads == ["style"]


def test_read_heretto_returns_the_reference_text(client, configured, upstream, monkeypatch):
    source = _FakeSource({"notes": "Release 4 drops Python 3.9."})
    monkeypatch.setattr(service, "heretto_reference_source", lambda org_id, db: source)
    _add_references(configured, ("notes", "general"))
    db = get_session_factory()()
    ref_id = str(db.query(AgentReference).filter_by(file_id="notes",
                 agent_id=uuid.UUID(configured["agent"]["id"])).one().id)
    db.close()
    _script_docs(upstream)
    upstream.ai_replies = [_tool_use("read_heretto", {"reference_id": ref_id}), _text("It drops 3.9.")]

    v = visitor_headers()
    base = _base(configured)
    cid = client.post(f"{base}/conversations", headers=v, json={}).json()["id"]
    events = sse_events(client.post(f"{base}/conversations/{cid}/messages", headers=v,
                                    json={"content": "What changed?"}).text)
    assert [d["label"] for e, d in events if e == "status"] == ["Reading reference material"]
    sent = upstream.bodies("api.anthropic.com")[1]["messages"][-1]["content"][0]["content"]
    assert sent == "Release 4 drops Python 3.9."


def test_an_empty_reply_cut_off_by_max_tokens_is_an_error(client, configured, upstream):
    _script_docs(upstream)
    upstream.ai_replies = [{"stop_reason": "max_tokens", "content": [{"type": "thinking", "thinking": "..."}]}]
    v = visitor_headers()
    base = _base(configured)
    cid = client.post(f"{base}/conversations", headers=v, json={}).json()["id"]
    events = sse_events(client.post(f"{base}/conversations/{cid}/messages", headers=v, json={"content": "Hi"}).text)
    assert events[-1][0] == "error"
    h = configured["operator"]["headers"]
    detail = client.get(f"/api/v1/chat-apps/{configured['chat_app']['id']}/conversations/{cid}", headers=h).json()
    assert "ran out of room before writing a reply" in detail["messages"][1]["details"]["error"]
