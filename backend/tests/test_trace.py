"""The Test tab's agent log: trace events are for operators holding a trace token only."""

from tests.conftest import register_user, sse_events, visitor_headers
from tests.test_public_chat import _base, _script_docs, _text, _tool_use


def _token(client, configured):
    h = configured["operator"]["headers"]
    resp = client.post(f"/api/v1/chat-apps/{configured['chat_app']['id']}/test-session", headers=h)
    assert resp.status_code == 200, resp.text
    return resp.json()["trace_token"]


def _send(client, configured, headers, content="How do I get started?"):
    base = _base(configured)
    cid = client.post(f"{base}/conversations", headers=headers, json={}).json()["id"]
    resp = client.post(f"{base}/conversations/{cid}/messages", headers=headers, json={"content": content})
    assert resp.status_code == 200, resp.text
    return sse_events(resp.text)


def _answer_with_tools(upstream):
    _script_docs(upstream)
    upstream.ai_replies = [
        {**_tool_use("search_docs", {"query": "getting started"}), "usage": {"input_tokens": 1200, "output_tokens": 40}},
        _tool_use("read_topic", {"path": "guide/start"}, "t2"),
        {**_text("Install the CLI."), "usage": {"input_tokens": 2400, "output_tokens": 60}},
    ]


def test_test_session_needs_an_operator_of_the_same_org(client, configured):
    app_id = configured["chat_app"]["id"]
    assert client.post(f"/api/v1/chat-apps/{app_id}/test-session").status_code == 401
    stranger = register_user(client)
    assert client.post(f"/api/v1/chat-apps/{app_id}/test-session", headers=stranger["headers"]).status_code == 404


def test_traced_reply_describes_the_whole_run_in_order(client, configured, upstream):
    _answer_with_tools(upstream)
    headers = {**visitor_headers(), "X-Hop-Trace": _token(client, configured)}
    events = _send(client, configured, headers)
    trace = [d for e, d in events if e == "trace"]
    assert [t["type"] for t in trace] == [
        "turn.start", "run.start",
        "model.request", "model.response", "tool.call", "tool.result",
        "model.request", "model.response", "tool.call", "tool.result",
        "model.request", "model.response",
        "run.end",
    ]
    by = lambda kind: [t for t in trace if t["type"] == kind]
    assert by("turn.start")[0]["content"] == "How do I get started?"
    start = by("run.start")[0]
    assert start["agent"] == configured["agent"]["name"]
    assert start["model"] == "claude-sonnet-5"
    assert start["deployment"]["organization_id"] == "acme"
    assert start["tools"] == ["search_docs", "read_topic", "browse_structure"]
    assert "Be friendly and brief." in start["system_prompt"]
    first = by("model.response")[0]
    assert first["stop_reason"] == "tool_use"
    assert (first["input_tokens"], first["output_tokens"]) == (1200, 40)
    assert first["tool_calls"] == [{"name": "search_docs", "args": {"query": "getting started"}}]
    search, read = by("tool.result")
    assert search["ok"] and search["summary"] == "1 of 1 results" and search["items"] == ["Getting started"]
    assert read["summary"].startswith("“Getting started”")
    end = by("run.end")[0]
    assert end["sources"] == ["Getting started"]
    assert all(isinstance(t["t_ms"], int) for t in trace)
    # Secrets never ride along.
    assert "sk-ant-test-key" not in str(trace) and "deploy-token" not in str(trace)
    # The visitor-facing events are unchanged.
    assert events[-1][0] == "message"


def test_failures_show_the_operators_version(client, configured, upstream):
    _script_docs(upstream)
    upstream.ai_replies = []  # the fake answers 500
    headers = {**visitor_headers(), "X-Hop-Trace": _token(client, configured)}
    trace = [d for e, d in _send(client, configured, headers) if e == "trace"]
    assert [t["type"] for t in trace][-3:] == ["model.request", "model.error", "run.error"]
    assert "Anthropic returned HTTP 500" in trace[-1]["message"]


def test_no_token_no_trace(client, configured, upstream):
    _answer_with_tools(upstream)
    events = _send(client, configured, visitor_headers())
    assert not [e for e, _ in events if e == "trace"]


def test_forged_or_foreign_tokens_are_ignored(client, configured, upstream, operator):
    other = client.post("/api/v1/chat-apps/", headers=configured["operator"]["headers"], json={"name": "Other"}).json()
    foreign = client.post(f"/api/v1/chat-apps/{other['id']}/test-session",
                          headers=configured["operator"]["headers"]).json()["trace_token"]
    for token in (foreign, "not-a-token", _token(client, configured) + "x"):
        _answer_with_tools(upstream)
        events = _send(client, configured, {**visitor_headers(), "X-Hop-Trace": token})
        assert not [e for e, _ in events if e == "trace"], token
