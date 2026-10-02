"""Serving the chat to visitors: the chat page and the embed loader.

- ``/c/{public_id}`` — the chat as a standalone page. This is the chat app's
  unique URL: link to it directly, or let the embed loader frame it.
- ``/embed/{public_id}.js`` — the one-line embed. It draws the launcher
  bubble on the host page and opens the chat page in an iframe when clicked.
  The chat app's appearance is baked into the script so the bubble renders
  immediately with no cross-origin request.
- ``/a/{public_id}`` — the search-answers panel, framed inside a docs
  portal's search results by ``/embed/{public_id}/search-answers.js``.
- ``/widget/static/*`` — the pages' scripts and stylesheets.

The chat page is framed on other sites, so it replaces hop-core's
``X-Frame-Options: DENY`` with a CSP ``frame-ancestors`` built from the chat
app's allowed origins.
"""

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse, Response
from sqlalchemy.orm import Session

from hop_core.db import get_db

from app.models import ChatApp
from app.routes.common import appearance_of, json_for_script, public_origin, search_settings_of

STATIC_DIR = Path(__file__).resolve().parent.parent / "widget" / "static"

router = APIRouter(tags=["widget"])


def _active(public_id: str, db: Session) -> ChatApp:
    chat_app = db.query(ChatApp).filter(ChatApp.public_id == public_id).first()
    if chat_app is None or not chat_app.is_active:
        raise HTTPException(status_code=404, detail="Chat not found")
    return chat_app


def frame_ancestors(chat_app: ChatApp) -> str:
    origins = list(chat_app.allowed_origins or [])
    if not origins:
        return "*"
    return " ".join(["'self'", *origins])


def _page_csp(chat_app: ChatApp) -> str:
    return "; ".join([
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data: https:",
        "connect-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
        f"frame-ancestors {frame_ancestors(chat_app)}",
    ])


_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>{title}</title>
<link rel="stylesheet" href="/widget/static/{name}.css">
</head>
<body>
<div id="{root}"></div>
<script type="application/json" id="hop-chat-config">{config}</script>
<script src="/widget/static/common.js"></script>
<script src="/widget/static/{name}.js"></script>
</body>
</html>
"""


def _page(chat_app: ChatApp, title: str, name: str, root: str, config: dict) -> HTMLResponse:
    from html import escape

    html = _PAGE.format(title=escape(title), name=name, root=root, config=json_for_script(config))
    return HTMLResponse(
        html,
        headers={
            "Content-Security-Policy": _page_csp(chat_app),
            "Cache-Control": "no-store",
            "X-Hop-Frameable": "1",
        },
    )


def _enabled_search(public_id: str, db: Session) -> ChatApp:
    chat_app = _active(public_id, db)
    if chat_app.search_widget is None or not chat_app.search_widget.enabled:
        raise HTTPException(status_code=404, detail="Search answers are not enabled for this chat")
    return chat_app


@router.get("/c/{public_id}", response_class=HTMLResponse, include_in_schema=False)
async def chat_page(public_id: str, db: Session = Depends(get_db)):
    chat_app = _active(public_id, db)
    appearance = appearance_of(chat_app)
    config = {
        "publicId": chat_app.public_id,
        "apiBase": f"/api/v1/public/chat/{chat_app.public_id}",
        "appearance": appearance.model_dump(),
    }
    return _page(chat_app, appearance.title, "chat", "hop-chat", config)


@router.get("/a/{public_id}", response_class=HTMLResponse, include_in_schema=False)
async def search_answers_page(public_id: str, db: Session = Depends(get_db)):
    chat_app = _enabled_search(public_id, db)
    appearance = appearance_of(chat_app)
    settings = search_settings_of(chat_app)
    config = {
        "publicId": chat_app.public_id,
        "apiBase": f"/api/v1/public/chat/{chat_app.public_id}",
        "appearance": appearance.model_dump(),
        "search": {"heading": settings.heading},
    }
    return _page(chat_app, settings.heading, "answer", "hop-answer", config)


@router.get("/embed/{public_id}.js", include_in_schema=False)
async def embed_script(public_id: str, db: Session = Depends(get_db)):
    chat_app = _active(public_id, db)
    appearance = appearance_of(chat_app)
    config = {
        "publicId": chat_app.public_id,
        "origin": public_origin(),
        "title": appearance.title,
        "accentColor": appearance.accent_color,
        "position": appearance.position,
    }
    loader = (STATIC_DIR / "embed.js").read_text(encoding="utf-8")
    body = f"(function(){{var HOP_CHAT_CONFIG={json_for_script(config)};\n{loader}\n}})();\n"
    return Response(
        body,
        media_type="application/javascript; charset=utf-8",
        # Short cache: appearance edits should reach sites within minutes.
        headers={"Cache-Control": "public, max-age=300"},
    )


@router.get("/embed/{public_id}/search-answers.js", include_in_schema=False)
async def search_answers_script(public_id: str, db: Session = Depends(get_db)):
    chat_app = _enabled_search(public_id, db)
    settings = search_settings_of(chat_app)
    config = {
        "publicId": chat_app.public_id,
        "origin": public_origin(),
        "title": settings.heading,
        "params": settings.query_params,
        "mountSelector": settings.mount_selector,
        "mountPosition": settings.mount_position,
    }
    loader = (STATIC_DIR / "search-embed.js").read_text(encoding="utf-8")
    body = f"(function(){{var HOP_SEARCH_CONFIG={json_for_script(config)};\n{loader}\n}})();\n"
    return Response(
        body,
        media_type="application/javascript; charset=utf-8",
        headers={"Cache-Control": "public, max-age=300"},
    )


_STATIC_TYPES = {".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8"}
# Only the pages' own assets. The loaders (embed.js, search-embed.js) are served
# with their configuration baked in, through /embed/.
_STATIC_FILES = {"common.js", "chat.js", "chat.css", "answer.js", "answer.css"}


@router.get("/widget/static/{name}", include_in_schema=False)
async def widget_static(name: str):
    if name not in _STATIC_FILES:
        raise HTTPException(status_code=404)
    path = STATIC_DIR / name
    return Response(
        path.read_text(encoding="utf-8"),
        media_type=_STATIC_TYPES[path.suffix],
        headers={"Cache-Control": "public, max-age=300"},
    )
