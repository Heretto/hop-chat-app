"""Adjustments to hop-core's middleware stack for visitor-facing paths.

Registered after ``create_hop_app`` so it runs outermost:

- **Cookies are stripped from visitor paths.** The admin UI and the chat share
  an origin, so a signed-in operator's browser sends its ``access_token``
  cookie to the chat too. The visitor API must never be authenticated by it,
  and hop-core's CSRF middleware would reject cookie-bearing POSTs without a
  CSRF header. Removing the cookie makes both true by construction.
- **Framable responses drop ``X-Frame-Options``.** hop-core sets ``DENY`` on
  everything; the chat page is meant to be framed, and marks itself with
  ``X-Hop-Frameable`` alongside its own CSP ``frame-ancestors``.
"""

from starlette.types import ASGIApp, Message, Receive, Scope, Send

VISITOR_PREFIXES = ("/api/v1/public/", "/c/", "/embed/", "/widget/")


class PublicPathMiddleware:
    def __init__(self, app: ASGIApp, api_prefix: str = "/api/v1"):
        self.app = app
        self.prefixes = tuple(
            p.replace("/api/v1", api_prefix.rstrip("/"), 1) for p in VISITOR_PREFIXES
        )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not scope["path"].startswith(self.prefixes):
            await self.app(scope, receive, send)
            return

        scope = dict(scope)
        scope["headers"] = [(k, v) for k, v in scope["headers"] if k.lower() != b"cookie"]

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = message.get("headers") or []
                if any(k.lower() == b"x-hop-frameable" for k, _ in headers):
                    message = dict(message)
                    message["headers"] = [
                        (k, v) for k, v in headers
                        if k.lower() not in (b"x-frame-options", b"x-hop-frameable")
                    ]
            await send(message)

        await self.app(scope, receive, send_wrapper)
