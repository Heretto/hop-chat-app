"""Visitor routes: what the embedded chat calls. No login.

A visitor is whoever holds a random token (``X-Visitor-Token``) their browser
generated and keeps in local storage. Only its SHA-256 is stored, and every
conversation lookup is scoped to (chat app, visitor hash), so transcripts are
private to the browser that created them.

These routes are served under ``/api/v1/public/…``; ``PublicPathMiddleware``
strips cookies from them, so an operator signed in to the admin UI on the same
origin neither authenticates nor trips CSRF checks here.
"""

import asyncio
import json
import logging
import re
import time
from typing import Any, AsyncIterator, Dict, List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from hop_core.agents import AiProviderError
from hop_core.ai import ChatMessage
from hop_core.core.rate_limit import limiter
from hop_core.db import get_db, get_session_factory

from app import trace as trace_tokens
from app.chat import service
from app.models import ChatApp, Conversation, ConversationMessage
from app.routes.common import appearance_of, load_chat_app, visitor_hash
from app.schemas import (
    ConversationDetail,
    ConversationSummary,
    MessageOut,
    NewConversation,
    PublicChatConfig,
    VisitorMessage,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/public/chat/{public_id}", tags=["public-chat"])

_TOKEN = re.compile(r"^[A-Za-z0-9_-]{32,128}$")
MAX_CONVERSATIONS_LISTED = 50


def _message_rate_limit() -> str:
    from hop_core.config import get_settings

    return getattr(get_settings(), "public_message_rate_limit", "20/minute")


def _visitor(x_visitor_token: Optional[str] = Header(None)) -> str:
    if not x_visitor_token or not _TOKEN.match(x_visitor_token):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing visitor token")
    return visitor_hash(x_visitor_token)


def _chat_app(public_id: str, db: Session) -> ChatApp:
    chat_app = load_chat_app(db, public_id=public_id)
    if chat_app is None or not chat_app.is_active:
        raise HTTPException(status_code=404, detail="Chat not found")
    return chat_app


def _conversation(chat_app: ChatApp, conversation_id: UUID, visitor: str, db: Session) -> Conversation:
    conversation = db.query(Conversation).filter(
        Conversation.id == conversation_id,
        Conversation.chat_app_id == chat_app.id,
        Conversation.visitor_hash == visitor,
    ).first()
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conversation


def _out(message: ConversationMessage, show_sources: bool) -> MessageOut:
    return MessageOut(
        id=message.id,
        role=message.role,
        content=message.content,
        sources=(message.sources or []) if show_sources else [],
        created_at=message.created_at,
    )


def _title_from(text: str) -> str:
    line = " ".join(text.split())
    return line if len(line) <= 60 else line[:57].rstrip() + "…"


@router.get("/config", response_model=PublicChatConfig)
async def get_config(public_id: str, db: Session = Depends(get_db)):
    chat_app = _chat_app(public_id, db)
    found = service.problems(chat_app)
    return PublicChatConfig(
        public_id=chat_app.public_id,
        appearance=appearance_of(chat_app),
        available=not found,
        unavailable_reason="This chat is not available right now." if found else None,
    )


@router.get("/conversations", response_model=List[ConversationSummary])
async def list_conversations(
    public_id: str, visitor: str = Depends(_visitor), db: Session = Depends(get_db)
):
    chat_app = _chat_app(public_id, db)
    rows = (
        db.query(Conversation)
        .filter(Conversation.chat_app_id == chat_app.id, Conversation.visitor_hash == visitor)
        .order_by(Conversation.updated_at.desc())
        .limit(MAX_CONVERSATIONS_LISTED)
        .all()
    )
    return [
        ConversationSummary(
            id=c.id, title=c.title, message_count=c.message_count,
            created_at=c.created_at, updated_at=c.updated_at,
        )
        for c in rows
    ]


@router.post("/conversations", response_model=ConversationDetail, status_code=201)
@limiter.limit("30/minute")
async def create_conversation(
    request: Request,
    public_id: str,
    data: NewConversation,
    visitor: str = Depends(_visitor),
    db: Session = Depends(get_db),
):
    chat_app = _chat_app(public_id, db)
    conversation = Conversation(
        chat_app_id=chat_app.id,
        visitor_hash=visitor,
        origin=(data.origin or "")[:512] or None,
        locale=data.locale,
    )
    db.add(conversation)
    db.commit()
    return ConversationDetail(
        id=conversation.id, title=conversation.title, message_count=0,
        created_at=conversation.created_at, updated_at=conversation.updated_at, messages=[],
    )


@router.get("/conversations/{conversation_id}", response_model=ConversationDetail)
async def get_conversation(
    public_id: str,
    conversation_id: UUID,
    visitor: str = Depends(_visitor),
    db: Session = Depends(get_db),
):
    chat_app = _chat_app(public_id, db)
    conversation = _conversation(chat_app, conversation_id, visitor, db)
    show_sources = appearance_of(chat_app).show_sources
    return ConversationDetail(
        id=conversation.id, title=conversation.title, message_count=conversation.message_count,
        created_at=conversation.created_at, updated_at=conversation.updated_at,
        messages=[_out(m, show_sources) for m in conversation.messages],
    )


@router.delete("/conversations/{conversation_id}")
async def delete_conversation(
    public_id: str,
    conversation_id: UUID,
    visitor: str = Depends(_visitor),
    db: Session = Depends(get_db),
):
    chat_app = _chat_app(public_id, db)
    conversation = _conversation(chat_app, conversation_id, visitor, db)
    db.delete(conversation)
    db.commit()
    return {"message": "Conversation deleted"}


def _sse(event: str, data: Dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False, default=str)}\n\n"


async def _reply_and_store(
    chat_app_id: UUID,
    conversation_id: UUID,
    locale: Optional[str],
    events: "asyncio.Queue[Optional[str]]",
    traced: bool = False,
) -> None:
    """Generate the reply and persist it — to completion, even if the visitor leaves.

    Runs in its own task with its own session: the request's session is gone
    by the time a streamed body is produced, and a visitor closing the tab
    should not lose an answer that is already paid for.
    """
    db = get_session_factory()()
    try:
        chat_app = load_chat_app(db, id=chat_app_id)
        conversation = db.query(Conversation).filter(Conversation.id == conversation_id).one()
        history = [
            ChatMessage(role=m.role, content=m.content)
            for m in conversation.messages
            if m.role in ("user", "assistant") and not (m.details or {}).get("error")
        ]
        show_sources = appearance_of(chat_app).show_sources
        started = time.monotonic()

        async def on_status(label: str) -> None:
            await events.put(_sse("status", {"label": label}))

        async def emit_trace(event: Dict[str, Any]) -> None:
            if traced:
                stamped = {"t_ms": int((time.monotonic() - started) * 1000), **event}
                await events.put(_sse("trace", stamped))

        await emit_trace({"type": "turn.start", "content": history[-1].content if history else ""})

        failure: Optional[str] = None
        try:
            reply = await service.answer(
                chat_app, history, locale=locale, on_status=on_status,
                trace=emit_trace if traced else None,
            )
            message = ConversationMessage(
                conversation_id=conversation.id, role="assistant", content=reply.content,
                sources=reply.sources, details=reply.details,
            )
        except service.ChatUnavailable as exc:
            failure = exc.public_message
            message = ConversationMessage(
                conversation_id=conversation.id, role="assistant", content=failure,
                details={"error": exc.operator_message},
            )
        except AiProviderError as exc:
            logger.warning("AI provider failed for chat app %s: %s", chat_app.public_id, exc.message)
            failure = "Sorry — I couldn't answer just now. Please try again in a moment."
            message = ConversationMessage(
                conversation_id=conversation.id, role="assistant", content=failure,
                details={"error": exc.message},
            )
        except Exception:
            logger.exception("Chat reply failed for chat app %s", chat_app.public_id)
            failure = "Sorry — something went wrong. Please try again."
            message = ConversationMessage(
                conversation_id=conversation.id, role="assistant", content=failure,
                details={"error": "Unexpected server error; see the server log."},
            )

        db.add(message)
        conversation.message_count = (conversation.message_count or 0) + 1
        db.commit()

        if failure:
            await emit_trace({"type": "run.error", "message": (message.details or {}).get("error") or failure})
        else:
            await emit_trace({
                "type": "run.end",
                "duration_ms": int((time.monotonic() - started) * 1000),
                "reply_chars": len(message.content),
                "sources": [s.get("title") for s in (message.sources or [])],
            })

        payload = _out(message, show_sources).model_dump(mode="json")
        await events.put(_sse("error" if failure else "message", payload))
    except Exception:
        logger.exception("Could not store a chat reply")
        await events.put(_sse("error", {"content": "Sorry — something went wrong. Please try again."}))
    finally:
        db.close()
        await events.put(None)


@router.post("/conversations/{conversation_id}/messages")
@limiter.limit(_message_rate_limit)
async def send_message(
    request: Request,
    public_id: str,
    conversation_id: UUID,
    data: VisitorMessage,
    visitor: str = Depends(_visitor),
    x_hop_trace: Optional[str] = Header(None),
    db: Session = Depends(get_db),
):
    """Store the visitor's message and stream the reply as server-sent events.

    Events: ``accepted`` (the stored user message), then any number of
    ``status`` (what the assistant is doing), then exactly one ``message`` (the
    stored reply) or ``error`` (a stored apology; details are kept for operators).

    With a valid ``X-Hop-Trace`` token (the admin Test tab), ``trace`` events
    describing the agent's work are interleaved as well.
    """
    chat_app = _chat_app(public_id, db)
    conversation = _conversation(chat_app, conversation_id, visitor, db)
    content = data.content.strip()
    if not content:
        raise HTTPException(status_code=422, detail="Message is empty")

    user_message = ConversationMessage(conversation_id=conversation.id, role="user", content=content)
    db.add(user_message)
    if conversation.message_count == 0:
        conversation.title = _title_from(content)
    conversation.message_count = (conversation.message_count or 0) + 1
    if data.locale and not conversation.locale:
        conversation.locale = data.locale
    db.commit()
    accepted = _out(user_message, False).model_dump(mode="json")
    locale = data.locale or conversation.locale

    events: "asyncio.Queue[Optional[str]]" = asyncio.Queue()
    traced = trace_tokens.verify(x_hop_trace, chat_app.id)
    task = asyncio.create_task(_reply_and_store(chat_app.id, conversation.id, locale, events, traced))
    _background.add(task)
    task.add_done_callback(_background.discard)

    async def stream() -> AsyncIterator[str]:
        yield _sse("accepted", accepted)
        while True:
            try:
                item = await asyncio.wait_for(events.get(), timeout=15)
            except asyncio.TimeoutError:
                yield ": keep-alive\n\n"  # stops proxies closing an idle stream
                continue
            if item is None:
                break
            yield item

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# Strong references to in-flight reply tasks, so they are not garbage-collected
# if the visitor disconnects and the stream stops awaiting them.
_background: "set[asyncio.Task]" = set()
