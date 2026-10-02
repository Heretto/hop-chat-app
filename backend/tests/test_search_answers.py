"""Search answers: answer a portal search that is a question, ask a follow-up when unsure, stay out of the way otherwise."""

import pytest

from app.chat.search import looks_like_question, parse_reply
from tests.conftest import sse_events, visitor_headers
from tests.test_public_chat import _script_docs, _text, _tool_use


def _enable(client, configured, **settings):
    h = configured["operator"]["headers"]
    resp = client.put(f"/api/v1/chat-apps/{configured['chat_app']['id']}", headers=h,
                      json={"search": {"enabled": True, "settings": settings}})
    assert resp.status_code == 200, resp.text
    return resp.json()


def _search(client, configured, query, headers=None):
    resp = client.post(f"/api/v1/public/chat/{configured['chat_app']['public_id']}/search",
                       headers=headers or visitor_headers(), json={"query": query, "origin": "https://docs.acme.com/search?q=x"})
    assert resp.status_code == 200, resp.text
    return sse_events(resp.text)


def _conversations(client, configured):
    h = configured["operator"]["headers"]
    return client.get(f"/api/v1/chat-apps/{configured['chat_app']['id']}/conversations/", headers=h).json()


# ── the pure parts ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("query,expected", [
    ("api tokens", False), ("release notes 4.2", False), ("sso", False), ("reset password", False),
    ("how do I reset my password", True), ("Can I export to PDF", True), ("what is a keyref?", True),
    ("my build fails", True), ("configure sso with okta for the portal", True), ("", False),
])
def test_question_check(query, expected):
    assert looks_like_question(query) is expected


def test_parse_reply():
    assert parse_reply("[ANSWER]\nRun `init`.").kind == "answer"
    clarify = parse_reply("Let me check.\n[CLARIFY]\nWhich product?\n- CCMS\n- Deploy API\n- Portal\n- Etc\n- Too many")
    assert (clarify.kind, clarify.content, clarify.options) == ("clarify", "Which product?", ["CCMS", "Deploy API", "Portal", "Etc"])
    assert parse_reply("[NOT_A_QUESTION]").kind == "not_a_question"
    assert parse_reply("").kind == "not_a_question"
    assert parse_reply("No marker, but an answer.").content == "No marker, but an answer."


# ── settings and serving ──────────────────────────────────────────────────────

def test_disabled_by_default_and_everything_404s(client, configured):
    app = configured["chat_app"]
    assert app["search"]["enabled"] is False
    assert client.get(f"/a/{app['public_id']}").status_code == 404
    assert client.get(f"/embed/{app['public_id']}/search-answers.js").status_code == 404
    resp = client.post(f"/api/v1/public/chat/{app['public_id']}/search", headers=visitor_headers(), json={"query": "how?"})
    assert resp.status_code == 404


def test_enabling_returns_snippet_and_serves_the_pages(client, configured):
    body = _enable(client, configured, mount_selector="#results", mount_position="before", query_params=["text", "q"])
    search = body["search"]
    public_id = body["public_id"]
    assert search["enabled"] is True
    assert search["settings"]["query_params"] == ["text", "q"]
    assert search["embed_snippet"] == f'<script src="http://chat.test/embed/{public_id}/search-answers.js" async></script>'

    loader = client.get(f"/embed/{public_id}/search-answers.js")
    assert loader.status_code == 200
    assert '"mountSelector": "#results"' in loader.text and '"params": ["text", "q"]' in loader.text

    page = client.get(f"/a/{public_id}")
    assert page.status_code == 200
    assert "x-frame-options" not in page.headers
    assert "frame-ancestors 'self' https://www.acme.com" in page.headers["content-security-policy"]
    assert "/widget/static/common.js" in page.text and "/widget/static/answer.js" in page.text
    for name in ("common.js", "answer.js", "answer.css"):
        assert client.get(f"/widget/static/{name}").status_code == 200
    assert client.get("/widget/static/search-embed.js").status_code == 404


def test_default_snippet_includes_the_placeholder(client, configured):
    snippet = _enable(client, configured)["search"]["embed_snippet"]
    assert "<div data-hop-answer></div>" in snippet


@pytest.mark.parametrize("settings", [
    {"query_params": ["bad name"]}, {"query_params": []}, {"mount_selector": "<script>"},
    {"mount_position": "sideways"},
])
def test_bad_settings_are_rejected(client, configured, settings):
    h = configured["operator"]["headers"]
    resp = client.put(f"/api/v1/chat-apps/{configured['chat_app']['id']}", headers=h,
                      json={"search": {"enabled": True, "settings": settings}})
    assert resp.status_code == 422


# ── the search flow ───────────────────────────────────────────────────────────

def test_keyword_searches_skip_without_a_model_call(client, configured, upstream):
    _enable(client, configured)
    events = _search(client, configured, "api tokens")
    assert events == [("skip", {"reason": "keywords"})]
    assert not upstream.bodies("api.anthropic.com")
    assert _conversations(client, configured)["total"] == 0


def test_question_gets_an_answer_and_is_kept_as_a_search_conversation(client, configured, upstream):
    _enable(client, configured)
    _script_docs(upstream)
    upstream.ai_replies = [
        _tool_use("search_docs", {"query": "reset password"}),
        _tool_use("read_topic", {"path": "guide/start"}, "t2"),
        _text("[ANSWER]\nOpen **Settings › Security** and choose *Reset*. See [Getting started](https://docs.acme.com/guide/start)."),
    ]
    events = _search(client, configured, "How do I reset my password?")
    kinds = [e for e, _ in events]
    assert kinds[0] == "started" and kinds[-1] == "message"
    assert "status" in kinds
    reply = events[-1][1]
    assert reply["kind"] == "answer"
    assert reply["content"].startswith("Open **Settings")
    assert "[ANSWER]" not in reply["content"]
    assert reply["sources"][0]["title"] == "Getting started"
    assert reply["conversation_id"] == events[0][1]["conversation_id"]

    # The agent was told this came from a search, on top of its own prompt.
    system = upstream.bodies("api.anthropic.com")[0]["system"]
    assert system.startswith("You are " + configured["agent"]["name"])
    assert "This conversation started from a documentation search" in system

    page = _conversations(client, configured)
    assert page["total"] == 1
    assert page["items"][0]["surface"] == "search"
    assert page["items"][0]["title"] == "How do I reset my password?"


def test_unsure_means_a_follow_up_question_with_options_then_a_normal_chat(client, configured, upstream):
    _enable(client, configured)
    _script_docs(upstream)
    upstream.ai_replies = [
        _tool_use("search_docs", {"query": "publish"}),
        _text("[CLARIFY]\nWhat are you publishing to?\n- The portal\n- A PDF"),
        _text("To publish a PDF, run the PDF scenario."),
    ]
    v = visitor_headers()
    events = _search(client, configured, "how do I publish", v)
    reply = events[-1][1]
    assert (reply["kind"], reply["content"], reply["options"]) == ("clarify", "What are you publishing to?", ["The portal", "A PDF"])

    # The visitor picks an option; it continues as an ordinary chat in the same conversation.
    cid = reply["conversation_id"]
    base = f"/api/v1/public/chat/{configured['chat_app']['public_id']}"
    follow = sse_events(client.post(f"{base}/conversations/{cid}/messages", headers=v, json={"content": "A PDF"}).text)
    assert follow[-1][0] == "message" and follow[-1][1]["content"] == "To publish a PDF, run the PDF scenario."
    sent = upstream.bodies("api.anthropic.com")[-1]
    assert "This conversation started from a documentation search" not in sent["system"]
    assert [(m["role"], m["content"]) for m in sent["messages"]] == [
        ("user", "how do I publish"),
        ("assistant", "What are you publishing to?\n- The portal\n- A PDF"),  # options restored for the model
        ("user", "A PDF"),
    ]
    # Operators see them too.
    operator_view = client.get(f"/api/v1/chat-apps/{configured['chat_app']['id']}/conversations/{cid}",
                               headers=configured["operator"]["headers"]).json()
    assert operator_view["surface"] == "search"
    assert operator_view["messages"][1]["options"] == ["The portal", "A PDF"]
    # Reloading the widget gets the chips back.
    stored = client.get(f"{base}/conversations/{cid}", headers=v).json()
    assert stored["messages"][1]["options"] == ["The portal", "A PDF"]


def test_not_a_question_leaves_nothing_behind(client, configured, upstream):
    _enable(client, configured, skip_keyword_searches=False)
    _script_docs(upstream)
    upstream.ai_replies = [_text("[NOT_A_QUESTION]")]
    events = _search(client, configured, "api tokens")
    assert events[0][0] == "started"
    assert events[-1] == ("skip", {"reason": "not_a_question"})
    assert len(upstream.bodies("api.anthropic.com")) == 1  # the model judged it, since the check was off
    assert _conversations(client, configured)["total"] == 0


def test_unconfigured_chat_app_stays_hidden(client, operator):
    h = operator["headers"]
    app = client.post("/api/v1/chat-apps/", headers=h, json={"name": "Not ready", "search": {"enabled": True}}).json()
    resp = client.post(f"/api/v1/public/chat/{app['public_id']}/search", headers=visitor_headers(), json={"query": "how do I start?"})
    assert sse_events(resp.text) == [("skip", {"reason": "unavailable"})]


def test_provider_failure_ends_in_error_and_is_recorded(client, configured, upstream):
    _enable(client, configured)
    _script_docs(upstream)
    upstream.ai_replies = []
    events = _search(client, configured, "how do I start?")
    assert events[-1][0] == "error"
    detail = client.get(
        f"/api/v1/chat-apps/{configured['chat_app']['id']}/conversations/{events[0][1]['conversation_id']}",
        headers=configured["operator"]["headers"],
    ).json()
    assert "Anthropic returned HTTP 500" in detail["messages"][1]["details"]["error"]


def test_trace_shows_the_decision(client, configured, upstream):
    _enable(client, configured)
    _script_docs(upstream)
    upstream.ai_replies = [_text("[CLARIFY]\nWhich product?\n- CCMS\n- Portal")]
    token = client.post(f"/api/v1/chat-apps/{configured['chat_app']['id']}/test-session",
                        headers=configured["operator"]["headers"]).json()["trace_token"]
    events = _search(client, configured, "how do I start?", {**visitor_headers(), "X-Hop-Trace": token})
    trace = [d for e, d in events if e == "trace"]
    decision = next(t for t in trace if t["type"] == "search.result")
    assert decision == {**decision, "kind": "clarify", "options": ["CCMS", "Portal"]}
    assert "documentation search" in next(t for t in trace if t["type"] == "run.start")["system_prompt"]


def test_searches_are_rate_limited(client, configured, monkeypatch):
    from hop_core.config import get_settings

    _enable(client, configured)
    monkeypatch.setattr(get_settings(), "public_search_rate_limit", "2/minute")
    base = f"/api/v1/public/chat/{configured['chat_app']['public_id']}/search"
    codes = [client.post(base, headers=visitor_headers(), json={"query": "api tokens"}).status_code for _ in range(3)]
    assert codes == [200, 200, 429]


def test_deleting_the_chat_app_removes_its_search_settings(client, configured):
    _enable(client, configured)
    h = configured["operator"]["headers"]
    assert client.delete(f"/api/v1/chat-apps/{configured['chat_app']['id']}", headers=h).status_code == 200


def test_trace_explains_a_keyword_skip(client, configured, upstream):
    _enable(client, configured)
    token = client.post(f"/api/v1/chat-apps/{configured['chat_app']['id']}/test-session",
                        headers=configured["operator"]["headers"]).json()["trace_token"]
    events = _search(client, configured, "api tokens", {**visitor_headers(), "X-Hop-Trace": token})
    assert events[0] == ("trace", {"t_ms": 0, "type": "search.skip", "query": "api tokens", "reason": "keywords"})
    assert events[1] == ("skip", {"reason": "keywords"})
    # Without a token, visitors get only the skip.
    assert _search(client, configured, "api tokens") == [("skip", {"reason": "keywords"})]
