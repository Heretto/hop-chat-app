"""Async client for the Heretto Deploy v4 API.

Covers the read endpoints a documentation chat needs, modelled on
Heretto's deploy MCP server (github.com/Heretto/heretto-deploy-mcp). That
server is configured per process from environment variables, which does not
fit an app where every chat app brings its own deployment and token, so the
same calls are made here directly with per-request configuration.
"""

import re
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

import httpx

API_BASE_TEMPLATE = "https://{organization_id}.deploy.heretto.com/v4"
TIMEOUT_SECONDS = 30.0

# The org ID becomes a hostname label, so it is held to exactly that shape —
# anything else could point the request at a host of the caller's choosing.
_ORG_ID = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")


class DeployError(RuntimeError):
    """A Deploy API call failed. ``message`` is safe to show an operator."""

    def __init__(self, message: str, status_code: Optional[int] = None, body: str = ""):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.body = body


@dataclass(frozen=True)
class DeployConfig:
    organization_id: str
    deployment_id: str
    token: str
    portal_base_url: str = ""
    audience: str = ""

    @classmethod
    def from_payload(cls, payload: Dict[str, Any]) -> "DeployConfig":
        """Build from a decrypted ``heretto_deploy`` credential payload."""
        org = str(payload.get("organization_id") or "").strip()
        deployment = str(payload.get("deployment_id") or "").strip()
        token = str(payload.get("token") or "").strip()
        if not org or not deployment or not token:
            raise ValueError("The Deploy credential needs an organization ID, deployment ID and token.")
        if not _ORG_ID.match(org):
            raise ValueError(
                "The organization ID should be the org alone (e.g. 'your-org'), not a URL."
            )
        if "/" in deployment or "?" in deployment or "#" in deployment:
            raise ValueError("The deployment ID must not contain '/', '?' or '#'.")
        portal = str(payload.get("portal_base_url") or "").strip().rstrip("/")
        if portal and not portal.startswith(("https://", "http://")):
            raise ValueError("The portal URL must start with https://")
        return cls(
            organization_id=org,
            deployment_id=deployment,
            token=token,
            portal_base_url=portal,
            audience=str(payload.get("audience") or "").strip(),
        )


def _describe_status(status_code: int) -> str:
    if status_code in (401, 403):
        return f"Deploy API rejected the token (HTTP {status_code})."
    if status_code == 404:
        return "Deploy API returned 404 — check the deployment ID, or the path requested."
    if status_code == 406:
        return "No content is published in the requested language (HTTP 406)."
    return f"Deploy API returned HTTP {status_code}."


class DeployClient:
    def __init__(self, config: DeployConfig, transport: Optional[httpx.AsyncBaseTransport] = None):
        self.config = config
        self._transport = transport

    # ── plumbing ──────────────────────────────────────────────────────────────

    def url(self, suffix: str) -> str:
        base = API_BASE_TEMPLATE.format(organization_id=self.config.organization_id)
        return f"{base}/deployments/{self.config.deployment_id}{suffix}"

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            timeout=TIMEOUT_SECONDS, follow_redirects=False, transport=self._transport
        )

    def _headers(self, locale: Optional[str]) -> Dict[str, str]:
        headers = {"X-Deploy-API-Auth": self.config.token, "Accept": "application/json"}
        if locale:
            headers["Accept-Language"] = locale
        return headers

    def _params(self, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        params = {k: v for k, v in (params or {}).items() if v not in (None, "")}
        if self.config.audience:
            params.setdefault("audience", self.config.audience)
        return params

    async def _request(
        self,
        method: str,
        suffix: str,
        params: Optional[Dict[str, Any]] = None,
        json: Any = None,
        locale: Optional[str] = None,
    ) -> Tuple[Any, int, str, int]:
        started = time.monotonic()
        try:
            async with self._client() as client:
                response = await client.request(
                    method, self.url(suffix), params=self._params(params),
                    json=json, headers=self._headers(locale),
                )
        except httpx.TimeoutException:
            raise DeployError(f"Deploy API did not answer within {int(TIMEOUT_SECONDS)}s.")
        except httpx.HTTPError as exc:
            raise DeployError(
                f"Could not reach the Deploy API ({type(exc).__name__}). Check the organization ID."
            )
        duration_ms = int((time.monotonic() - started) * 1000)
        body = response.text or ""
        if response.is_redirect:
            raise DeployError(
                f"Deploy API redirected the request (HTTP {response.status_code}); redirects are not followed.",
                response.status_code, body,
            )
        if response.status_code >= 400:
            raise DeployError(_describe_status(response.status_code), response.status_code, body)
        if response.status_code == 204 or not body:
            return None, response.status_code, body, duration_ms
        try:
            return response.json(), response.status_code, body, duration_ms
        except ValueError:
            raise DeployError("Deploy API returned a non-JSON body.", response.status_code, body)

    # ── endpoints ─────────────────────────────────────────────────────────────

    async def get_deployment_with_exchange(self):
        return await self._request("GET", "")

    async def get_deployment(self) -> Dict[str, Any]:
        data, *_ = await self._request("GET", "")
        return data or {}

    async def search(
        self,
        query: str,
        locale: Optional[str] = None,
        limit: int = 8,
        refine_to_paths: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {"queryString": query, "startOffset": 0, "endOffset": limit}
        if refine_to_paths:
            body["refineToPaths"] = refine_to_paths
        data, *_ = await self._request("POST", "/search", json=body, locale=locale)
        return data or {}

    async def get_content(
        self,
        for_path: Optional[str] = None,
        for_id: Optional[str] = None,
        locale: Optional[str] = None,
    ) -> Dict[str, Any]:
        if not for_path and not for_id:
            raise DeployError("Provide a path or an id.")
        params = {"for-path": for_path} if for_path else {"for-id": for_id}
        data, *_ = await self._request("GET", "/content", params=params, locale=locale)
        return data or {}

    async def get_structure(self, for_path: Optional[str] = None, depth: Optional[int] = None) -> Any:
        data, *_ = await self._request(
            "GET", "/structure", params={"for-path": for_path, "depth": depth}
        )
        return data

    # ── links ─────────────────────────────────────────────────────────────────

    def portal_url(self, href: Optional[str]) -> Optional[str]:
        """The reader-facing page for a content path, when a portal is configured."""
        if not self.config.portal_base_url or not href or not isinstance(href, str):
            return None
        if href.startswith(("http://", "https://")):
            return None
        return f"{self.config.portal_base_url}{'' if href.startswith('/') else '/'}{href}"
