"""SSO_ONLY: hop-core's sign-up/sign-in rules hold inside this app.

hop-core enforces SSO_ONLY itself; these tests guard the integration, so that
nothing this app adds (its middleware, its routes, the visitor API) opens a
password path around it, and that the visitor chat keeps working.
"""

import uuid

import pytest
from hop_core.config import get_settings

from tests.conftest import register_user

PASSWORD = "SecurePass123!"


@pytest.fixture
def sso_only(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "sso_only", True)
    monkeypatch.setattr(settings, "google_oauth_client_id", "test-client.apps.googleusercontent.com")
    return settings


def test_password_sign_up_is_refused(client, sso_only):
    resp = client.post("/api/v1/auth/register",
                       json={"email": f"s-{uuid.uuid4().hex[:8]}@example.com", "password": PASSWORD})
    assert resp.status_code == 403
    assert "SSO" in resp.json()["detail"]


def test_password_login_and_reset_are_refused(client, monkeypatch):
    user = register_user(client)              # an existing password account, made before the switch
    settings = get_settings()
    monkeypatch.setattr(settings, "sso_only", True)
    assert client.post("/api/v1/auth/login", json={"email": user["email"], "password": PASSWORD}).status_code == 403
    assert client.post("/api/v1/auth/forgot-password", json={"email": user["email"]}).status_code == 403
    assert client.post("/api/v1/auth/reset-password",
                       json={"token": "x", "new_password": PASSWORD}).status_code == 403


def test_password_invitation_acceptance_is_refused(client, operator, monkeypatch):
    invite = client.post("/api/v1/organizations/invitations", headers=operator["headers"],
                         json={"email": f"inv-{uuid.uuid4().hex[:8]}@example.com", "role": "member"})
    assert invite.status_code in (200, 201), invite.text
    monkeypatch.setattr(get_settings(), "sso_only", True)
    client.cookies.clear()
    resp = client.post(f"/api/v1/invitations/accept/{invite.json()['token']}",
                       json={"password": PASSWORD, "confirm_password": PASSWORD})
    assert resp.status_code == 403


def test_login_page_is_told_to_offer_only_sso(client, sso_only):
    providers = client.get("/api/v1/auth/sso/providers").json()
    assert providers["sso_only"] is True
    assert providers["google"] is True
    assert providers["google_client_id"] == "test-client.apps.googleusercontent.com"


def test_visitor_chat_is_unaffected(client, configured, sso_only):
    base = f"/api/v1/public/chat/{configured['chat_app']['public_id']}"
    assert client.get(f"{base}/config").status_code == 200
    v = {"X-Visitor-Token": "v" + uuid.uuid4().hex * 2}
    assert client.post(f"{base}/conversations", headers=v, json={}).status_code == 201
    assert client.get(f"/c/{configured['chat_app']['public_id']}").status_code == 200
