def test_chat_page_is_frameable_only_by_allowed_origins(client, configured):
    public_id = configured["chat_app"]["public_id"]
    resp = client.get(f"/c/{public_id}")
    assert resp.status_code == 200
    assert "x-frame-options" not in resp.headers
    assert "x-hop-frameable" not in resp.headers
    csp = resp.headers["content-security-policy"]
    assert "frame-ancestors 'self' https://www.acme.com" in csp
    assert "script-src 'self'" in csp
    assert f'"publicId": "{public_id}"' in resp.text


def test_config_json_cannot_break_out_of_its_script_tag(client, configured):
    h = configured["operator"]["headers"]
    app = configured["chat_app"]
    client.put(f"/api/v1/chat-apps/{app['id']}", headers=h,
               json={"appearance": {"title": "</script><script>alert(1)</script>"}})
    page = client.get(f"/c/{app['public_id']}").text
    assert "</script><script>alert(1)" not in page
    assert "&lt;/script&gt;" in page  # the <title>


def test_no_allowed_origins_means_frameable_anywhere(client, configured):
    h = configured["operator"]["headers"]
    app = configured["chat_app"]
    client.put(f"/api/v1/chat-apps/{app['id']}", headers=h, json={"allowed_origins": []})
    assert "frame-ancestors *" in client.get(f"/c/{app['public_id']}").headers["content-security-policy"]


def test_admin_api_still_denies_framing(client, operator):
    resp = client.get("/api/v1/chat-apps/", headers=operator["headers"])
    assert resp.headers["x-frame-options"] == "DENY"


def test_embed_script_carries_the_appearance(client, configured):
    public_id = configured["chat_app"]["public_id"]
    resp = client.get(f"/embed/{public_id}.js")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/javascript")
    assert f'"publicId": "{public_id}"' in resp.text
    assert '"origin": "http://chat.test"' in resp.text
    assert "attachShadow" in resp.text


def test_inactive_or_unknown_chat_is_404(client, configured):
    h = configured["operator"]["headers"]
    app = configured["chat_app"]
    client.put(f"/api/v1/chat-apps/{app['id']}", headers=h, json={"is_active": False})
    assert client.get(f"/c/{app['public_id']}").status_code == 404
    assert client.get(f"/embed/{app['public_id']}.js").status_code == 404
    assert client.get("/c/does-not-exist").status_code == 404


def test_static_assets(client):
    assert client.get("/widget/static/chat.js").status_code == 200
    assert client.get("/widget/static/chat.css").status_code == 200
    assert client.get("/widget/static/embed.js").status_code == 404
    assert client.get("/widget/static/..%2Fmain.py").status_code == 404


def test_health(client):
    assert client.get("/api/health").json()["status"] == "ok"
