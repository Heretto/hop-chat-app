"""The Heretto Deploy credential type.

A chat app answers from one published Deploy deployment. The token, org and
deployment live in an ordinary hop-core credential so they are encrypted at
rest, managed in the standard credentials UI (with a working Test button), and
shareable between chat apps.
"""

from typing import Any, Dict

from hop_core.credentials import CredentialTestResult, CredentialTesterRegistry
from hop_core.credentials.testing import CredentialTestExchange, MAX_BODY_CHARS
from hop_core.models.enums import CredentialTypeRegistry

from app.deploy.client import DeployClient, DeployConfig, DeployError

DEPLOY_CREDENTIAL_TYPE = "heretto_deploy"

FIELDS = [
    {
        "name": "organization_id",
        "label": "Organization ID",
        "type": "text",
        "required": True,
        "secret": False,
        "summary": True,
        "placeholder": "your-org",
        "help": "The first part of your Deploy address: https://your-org.deploy.heretto.com",
    },
    {
        "name": "deployment_id",
        "label": "Deployment ID",
        "type": "text",
        "required": True,
        "secret": False,
        "summary": True,
        "placeholder": "",
        "help": "The published deployment the chat answers from.",
    },
    {
        "name": "token",
        "label": "Deploy API Token",
        "type": "password",
        "required": True,
        "secret": True,
        "summary": False,
        "placeholder": "",
        "help": "Sent as the X-Deploy-API-Auth header.",
    },
    {
        "name": "portal_base_url",
        "label": "Portal URL",
        "type": "url",
        "required": False,
        "secret": False,
        "summary": True,
        "placeholder": "https://your-org.portal.heretto.com",
        "help": "Your reader-facing portal. Answers link to topics here.",
    },
    {
        "name": "audience",
        "label": "Audience",
        "type": "text",
        "required": False,
        "secret": False,
        "summary": False,
        "placeholder": "",
        "help": "Restrict every answer to one audience, so internal content never "
                "reaches a public chat. Leave blank for the whole deployment.",
    },
]


async def test_deploy_credential(payload: Dict[str, Any]) -> CredentialTestResult:
    """Read the deployment's details — authenticated, and changes nothing."""
    config = DeployConfig.from_payload(payload)
    client = DeployClient(config)
    url = client.url("")
    try:
        info, status_code, body, duration_ms = await client.get_deployment_with_exchange()
    except DeployError as exc:
        exchange = None
        if exc.status_code is not None:
            exchange = CredentialTestExchange(
                method="GET", url=url, status_code=exc.status_code,
                response_body=(exc.body or "")[:MAX_BODY_CHARS],
                body_truncated=len(exc.body or "") > MAX_BODY_CHARS,
            )
        return CredentialTestResult(success=False, message=exc.message, exchange=exchange)

    exchange = CredentialTestExchange(
        method="GET", url=url, status_code=status_code,
        response_body=body[:MAX_BODY_CHARS], body_truncated=len(body) > MAX_BODY_CHARS,
        duration_ms=duration_ms,
    )
    title = (info or {}).get("title") or config.deployment_id
    return CredentialTestResult(
        success=True,
        message=f"Connected to deployment “{title}”.",
        details={"title": title, "publishing_date": (info or {}).get("publishingDate")},
        exchange=exchange,
    )


def register_deploy_credential_type() -> None:
    CredentialTypeRegistry.register(
        DEPLOY_CREDENTIAL_TYPE,
        label="Heretto Deploy",
        icon="cloud_done",
        description="A published Heretto Deploy deployment that chat apps answer from.",
        fields=FIELDS,
    )
    CredentialTesterRegistry.register(DEPLOY_CREDENTIAL_TYPE, test_deploy_credential)
