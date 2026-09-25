from tests.conftest import register_user, sse_events, visitor_headers


def _tool_use(name, args, tid="t1"):
    return {"stop_reason": "tool_use", "content": [
        {"type": "text", "text": "Let me look."},
        {"type": "tool_use", "id": tid, "name": name, "input": args},
    ]}


def _text(text):
    return {"stop_reason": "end_turn", "content": [{"type": "text", "text": text}]}


def _script_docs(upstream):
    upstream.deploy[""] = (200, {"title": "Acme Docs"})
    upstream.deploy["/search"] = (200, {"totalResults": 1, "hits": [
        {"title": "Getting started", "href": "guide/start", "shortDescription": "First steps"},
    ]})
    upstream.deploy["/content"] = (200, {
        "title": "Getting started", "href": "guide/start", "content": "<p>Install the CLI, then run init.</p>",
    })


def _base(configured):
    return f"/api/v1/public/chat/{configured['chat_app']['public_id']}"


def test_config_is_public(client, configured):
    body = client.get(f"{_base(configured)}/config").json()
    assert body["available"] is True
    assert body["appearance"]["title"] == "Acme Help"
    assert set(body) == {"public_id", "appearance", "available", "unavailable_reason"}


def test_visitor_token_is_required(client, configured):
    assert client.get(f"{_base(configured)}/conversations").status_code == 401
    assert client.get(f"{_base(configured)}/conversations", headers={"X-Visitor-Token": "short"}).status_code == 401


def test_full_exchange_searches_reads_answers_and_stores_the_transcript(client, configured, upstream):
    _script_docs(upstream)
    upstream.ai_replies = [
        _tool_use("search_docs", {"query": "getting started"}),
        _tool_use("read_topic", {"path": "guide/start"}, "t2"),
        _text("Install the CLI, then run `init`. See [Getting started](https://docs.acme.com/guide/start)."),
    ]
    v = visitor_headers()
    base = _base(configured)
    conv = client.post(f"{base}/conversations", headers=v, json={"origin": "https://www.acme.com/pricing"})
    assert conv.status_code == 201
    cid = conv.json()["id"]

    resp = client.post(f"{base}/conversations/{cid}/messages", headers=v,
                       json={"content": "How do I get started?", "locale": "en-US"})
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    events = sse_events(resp.text)
    kinds = [e for e, _ in events]
    assert kinds[0] == "accepted" and kinds[-1] == "message"
    statuses = [d["label"] for e, d in events if e == "status"]
    assert statuses == ["Searching the docs for “getting started”", "Reading a topic"]
    reply = events[-1][1]
    assert "run `init`" in reply["content"]
    assert reply["sources"] == [{"title": "Getting started", "path": "guide/start",
                                 "url": "https://docs.acme.com/guide/start"}]

    # What the model was told: the hop-core agent's prompt plus the docs guidance.
    first_call = upstream.bodies("api.anthropic.com")[0]
    assert first_call["system"].startswith("You are " + configured["agent"]["name"])
    assert "Be friendly and brief." in first_call["system"]
    assert "Acme Docs" in first_call["system"]
    assert [t["name"] for t in first_call["tools"]] == ["search_docs", "read_topic", "browse_structure"]
    assert first_call["model"] == "claude-sonnet-5"
    deploy_calls = [r for r in upstream.requests if r.url.host == "acme.deploy.heretto.com"]
    assert all(r.headers["x-deploy-api-auth"] == "deploy-token-000000" for r in deploy_calls)
    assert any(r.headers.get("accept-language") == "en-US" for r in deploy_calls)

    # The visitor gets the transcript back...
    stored = client.get(f"{base}/conversations/{cid}", headers=v).json()
    assert stored["title"] == "How do I get started?"
    assert [m["role"] for m in stored["messages"]] == ["user", "assistant"]
    listed = client.get(f"{base}/conversations", headers=v).json()
    assert [c["id"] for c in listed] == [cid]

    # ...and so does the operator, with what produced the reply.
    h = configured["operator"]["headers"]
    app_id = configured["chat_app"]["id"]
    page = client.get(f"/api/v1/chat-apps/{app_id}/conversations/", headers=h).json()
    assert page["total"] == 1
    assert page["items"][0]["origin"] == "https://www.acme.com/pricing"
    assert page["items"][0]["visitor"].startswith("Visitor ")
    detail = client.get(f"/api/v1/chat-apps/{app_id}/conversations/{cid}", headers=h).json()
    details = detail["messages"][1]["details"]
    assert details["model"] == "claude-sonnet-5"
    assert [c["tool"] for c in details["tool_calls"]] == ["search_docs", "read_topic"]


def test_history_is_sent_on_follow_up_messages(client, configured, upstream):
    _script_docs(upstream)
    upstream.ai_replies = [_text("First answer."), _text("Second answer.")]
    v = visitor_headers()
    base = _base(configured)
    cid = client.post(f"{base}/conversations", headers=v, json={}).json()["id"]
    client.post(f"{base}/conversations/{cid}/messages", headers=v, json={"content": "One?"})
    client.post(f"{base}/conversations/{cid}/messages", headers=v, json={"content": "Two?"})
    second = upstream.bodies("api.anthropic.com")[1]
    assert [(m["role"], m["content"]) for m in second["messages"]] == [
        ("user", "One?"), ("assistant", "First answer."), ("user", "Two?"),
    ]


def test_conversations_are_private_to_the_visitor(client, configured, upstream):
    base = _base(configured)
    owner, other = visitor_headers(), visitor_headers()
    cid = client.post(f"{base}/conversations", headers=owner, json={}).json()["id"]
    assert client.get(f"{base}/conversations/{cid}", headers=other).status_code == 404
    assert client.post(f"{base}/conversations/{cid}/messages", headers=other, json={"content": "hi"}).status_code == 404
    assert client.delete(f"{base}/conversations/{cid}", headers=other).status_code == 404
    assert client.get(f"{base}/conversations", headers=other).json() == []
    assert client.delete(f"{base}/conversations/{cid}", headers=owner).status_code == 200


def test_conversations_do_not_cross_chat_apps(client, configured, operator):
    h = configured["operator"]["headers"]
    other_app = client.post("/api/v1/chat-apps/", headers=h, json={"name": "Second site"}).json()
    v = visitor_headers()
    cid = client.post(f"{_base(configured)}/conversations", headers=v, json={}).json()["id"]
    resp = client.get(f"/api/v1/public/chat/{other_app['public_id']}/conversations/{cid}", headers=v)
    assert resp.status_code == 404


def test_provider_failure_is_stored_for_operators_and_softened_for_visitors(client, configured, upstream):
    _script_docs(upstream)
    upstream.ai_replies = []  # the fake answers 500
    v = visitor_headers()
    base = _base(configured)
    cid = client.post(f"{base}/conversations", headers=v, json={}).json()["id"]
    events = sse_events(client.post(f"{base}/conversations/{cid}/messages", headers=v, json={"content": "Hi"}).text)
    assert events[-1][0] == "error"
    assert "HTTP 500" not in events[-1][1]["content"]
    h = configured["operator"]["headers"]
    detail = client.get(f"/api/v1/chat-apps/{configured['chat_app']['id']}/conversations/{cid}", headers=h).json()
    assert "Anthropic returned HTTP 500" in detail["messages"][1]["details"]["error"]

    # A failed turn is not replayed to the model as if it were an answer.
    upstream.ai_replies = [_text("Recovered.")]
    client.post(f"{base}/conversations/{cid}/messages", headers=v, json={"content": "Again"})
    sent = upstream.bodies("api.anthropic.com")[-1]["messages"]
    assert [m["role"] for m in sent] == ["user", "user"]


def test_unconfigured_chat_reports_unavailable(client, operator):
    app = client.post("/api/v1/chat-apps/", headers=operator["headers"], json={"name": "Not ready"}).json()
    base = f"/api/v1/public/chat/{app['public_id']}"
    assert client.get(f"{base}/config").json()["available"] is False
    v = visitor_headers()
    cid = client.post(f"{base}/conversations", headers=v, json={}).json()["id"]
    events = sse_events(client.post(f"{base}/conversations/{cid}/messages", headers=v, json={"content": "Hi"}).text)
    assert events[-1][0] == "error"
    assert events[-1][1]["content"] == "This chat is not available right now."


def test_signed_in_operator_cookie_neither_authenticates_nor_trips_csrf(client, configured, upstream):
    """Admin UI and chat share an origin; the operator's cookies must not matter here."""
    _script_docs(upstream)
    upstream.ai_replies = [_text("Hello.")]
    user = register_user(client)
    client.post("/api/v1/auth/login", json={"email": user["email"], "password": "SecurePass123!"})
    assert "access_token" in client.cookies
    v = visitor_headers()
    base = _base(configured)
    created = client.post(f"{base}/conversations", headers=v, json={})
    assert created.status_code == 201, created.text
    sent = client.post(f"{base}/conversations/{created.json()['id']}/messages", headers=v, json={"content": "Hi"})
    assert sent.status_code == 200, sent.text


def test_messages_are_rate_limited(client, configured, upstream, monkeypatch):
    from hop_core.config import get_settings

    monkeypatch.setattr(get_settings(), "public_message_rate_limit", "2/minute")
    _script_docs(upstream)
    upstream.ai_replies = [_text("a"), _text("b"), _text("c")]
    v = visitor_headers()
    base = _base(configured)
    cid = client.post(f"{base}/conversations", headers=v, json={}).json()["id"]
    codes = [client.post(f"{base}/conversations/{cid}/messages", headers=v, json={"content": "x"}).status_code
             for _ in range(3)]
    assert codes == [200, 200, 429]


def test_timestamps_carry_a_utc_offset(client, configured):
    v = visitor_headers()
    body = client.post(f"{_base(configured)}/conversations", headers=v, json={}).json()
    assert body["created_at"].endswith(("+00:00", "Z")), body["created_at"]
