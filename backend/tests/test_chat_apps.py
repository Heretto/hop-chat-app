from tests.conftest import register_user, unique


def test_collection_requires_auth(client):
    assert client.get("/api/v1/chat-apps/").status_code == 401


def test_create_returns_urls_snippet_and_no_problems(client, configured):
    app = configured["chat_app"]
    assert app["problems"] == []
    assert app["chat_url"] == f"http://chat.test/c/{app['public_id']}"
    assert app["embed_snippet"] == f'<script src="http://chat.test/embed/{app["public_id"]}.js" async></script>'
    assert app["agent"]["provider"] == "anthropic"
    assert app["agent"]["model"] == "claude-sonnet-5"
    assert app["deploy_credential"]["organization_id"] == "acme"
    assert "token" not in app["deploy_credential"]
    assert app["appearance"]["title"] == "Acme Help"
    assert app["appearance"]["accent_color"] == "#011627"
    assert app["allowed_origins"] == ["https://www.acme.com"]


def test_unconfigured_chat_app_lists_its_problems(client, operator):
    resp = client.post("/api/v1/chat-apps/", headers=operator["headers"], json={"name": unique("Bare")})
    assert resp.status_code == 201
    problems = resp.json()["problems"]
    assert "No agent is selected." in problems
    assert "No Heretto Deploy credential is selected." in problems


def test_origins_are_normalized_and_validated(client, operator):
    h = operator["headers"]
    resp = client.post("/api/v1/chat-apps/", headers=h, json={
        "name": unique("Origins"), "allowed_origins": ["WWW.Example.com/docs", "https://app.example.com:8443/x", ""],
    })
    assert resp.status_code == 201, resp.text
    assert resp.json()["allowed_origins"] == ["https://www.example.com", "https://app.example.com:8443"]
    bad = client.post("/api/v1/chat-apps/", headers=h, json={"name": unique("Bad"), "allowed_origins": ["*"]})
    assert bad.status_code == 422


def test_bad_colour_is_rejected(client, operator):
    resp = client.post("/api/v1/chat-apps/", headers=operator["headers"], json={
        "name": unique("Colour"), "appearance": {"accent_color": "red"},
    })
    assert resp.status_code == 422


def test_duplicate_names_are_rejected(client, operator):
    name = unique("Dup")
    h = operator["headers"]
    assert client.post("/api/v1/chat-apps/", headers=h, json={"name": name}).status_code == 201
    assert client.post("/api/v1/chat-apps/", headers=h, json={"name": name}).status_code == 400


def test_non_deploy_credential_cannot_be_the_content_source(client, configured):
    h = configured["operator"]["headers"]
    resp = client.put(f"/api/v1/chat-apps/{configured['chat_app']['id']}", headers=h,
                      json={"deploy_credential_id": configured["ai"]["id"]})
    assert resp.status_code == 400


def test_update_is_partial(client, configured):
    h = configured["operator"]["headers"]
    app_id = configured["chat_app"]["id"]
    resp = client.put(f"/api/v1/chat-apps/{app_id}", headers=h, json={"is_active": False})
    assert resp.status_code == 200
    body = resp.json()
    assert body["is_active"] is False
    assert body["agent_id"] == configured["agent"]["id"]
    assert "The chat app is switched off." in body["problems"]


def test_rotating_the_public_id_retires_the_old_url(client, configured):
    h = configured["operator"]["headers"]
    old = configured["chat_app"]["public_id"]
    resp = client.post(f"/api/v1/chat-apps/{configured['chat_app']['id']}/rotate-public-id", headers=h)
    assert resp.status_code == 200
    new = resp.json()["public_id"]
    assert new != old
    assert client.get(f"/c/{old}").status_code == 404
    assert client.get(f"/c/{new}").status_code == 200


def test_other_organizations_cannot_see_a_chat_app(client, configured):
    stranger = register_user(client)
    app_id = configured["chat_app"]["id"]
    assert client.get(f"/api/v1/chat-apps/{app_id}", headers=stranger["headers"]).status_code == 404
    assert client.get("/api/v1/chat-apps/", headers=stranger["headers"]).json() == []
    # ...nor point a chat app at another org's agent.
    resp = client.post("/api/v1/chat-apps/", headers=stranger["headers"],
                       json={"name": unique("Steal"), "agent_id": configured["agent"]["id"]})
    assert resp.status_code == 400


def test_delete(client, configured):
    h = configured["operator"]["headers"]
    app_id = configured["chat_app"]["id"]
    assert client.delete(f"/api/v1/chat-apps/{app_id}", headers=h).status_code == 200
    assert client.get(f"/api/v1/chat-apps/{app_id}", headers=h).status_code == 404


def test_deploy_credential_type_is_registered_with_a_tester(client, operator):
    types = client.get("/api/v1/credentials/types", headers=operator["headers"]).json()
    deploy = next(t for t in types if t["type"] == "heretto_deploy")
    assert deploy["testable"] is True
    assert [f["name"] for f in deploy["fields"] if f["secret"]] == ["token"]


def test_deploy_credential_test_button(client, configured, upstream):
    upstream.deploy[""] = (200, {"title": "Acme Docs", "publishingDate": "2026-09-01"})
    h = configured["operator"]["headers"]
    resp = client.post(f"/api/v1/credentials/{configured['deploy']['id']}/test", headers=h)
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True, body
    assert "Acme Docs" in body["message"]
    assert "deploy-token" not in str(body)
