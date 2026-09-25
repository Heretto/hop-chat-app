"""Chat app models.

A **chat app** is the embeddable, visitor-facing surface of a hop-core agent:
it points at one agent (which owns the model, instructions, context files and
memory) and one Heretto Deploy credential (which owns what content it answers
from), and adds presentation and embedding settings. Several chat apps can
share an agent — one per website or product, each with its own URL.

Conversations and their messages are the retained transcripts. A visitor is
identified only by the hash of an opaque random token their browser holds, so
a transcript is readable by the browser that created it and by the org's
operators, and by nobody else.

These tables share hop-core's declarative ``Base``, so hop-core's startup
``create_all`` creates them.
"""

import secrets
import uuid
from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, Column, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from hop_core.db import Base


def _now() -> datetime:
    # Set in Python, not by the database: SQLite's CURRENT_TIMESTAMP has
    # one-second resolution, which would tie a question and its answer.
    return datetime.now(timezone.utc)


def new_public_id() -> str:
    # 12 url-safe characters ≈ 72 bits: unguessable, and short enough for a URL.
    return secrets.token_urlsafe(9)


class ChatApp(Base):
    __tablename__ = "chat_apps"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    organization_id = Column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    # The identifier in public URLs (/c/{public_id}, /embed/{public_id}.js).
    public_id = Column(String(32), nullable=False, unique=True, default=new_public_id)
    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)

    # SET NULL, not CASCADE: deleting an agent or credential must leave the
    # chat app visibly unconfigured, not silently delete it and its history.
    agent_id = Column(UUID(as_uuid=True), ForeignKey("agents.id", ondelete="SET NULL"), nullable=True)
    deploy_credential_id = Column(
        UUID(as_uuid=True), ForeignKey("credentials.id", ondelete="SET NULL"), nullable=True
    )

    # Presentation: title, welcome message, suggestions, colours, position.
    appearance = Column(JSON, nullable=False, default=dict)
    # Origins allowed to frame the chat (CSP frame-ancestors). Empty = anywhere.
    allowed_origins = Column(JSON, nullable=False, default=list)

    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    created_by = Column(String(255), nullable=True)

    agent = relationship("Agent", foreign_keys=[agent_id])
    deploy_credential = relationship("Credential", foreign_keys=[deploy_credential_id])
    conversations = relationship(
        "Conversation", back_populates="chat_app", cascade="all, delete-orphan"
    )


class Conversation(Base):
    __tablename__ = "chat_conversations"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    chat_app_id = Column(
        UUID(as_uuid=True), ForeignKey("chat_apps.id", ondelete="CASCADE"), nullable=False
    )
    # sha256 of the visitor's token — the token itself is never stored.
    visitor_hash = Column(String(64), nullable=False)
    title = Column(String(255), nullable=False, default="New conversation")
    message_count = Column(Integer, nullable=False, default=0)
    # The page the visitor was on and their language, for operators reading transcripts.
    origin = Column(String(512), nullable=True)
    locale = Column(String(35), nullable=True)
    created_at = Column(DateTime(timezone=True), default=_now)
    updated_at = Column(DateTime(timezone=True), default=_now, onupdate=_now)

    chat_app = relationship("ChatApp", back_populates="conversations")
    messages = relationship(
        "ConversationMessage",
        back_populates="conversation",
        cascade="all, delete-orphan",
        order_by="ConversationMessage.created_at",
    )

    __table_args__ = (Index("ix_chat_conversations_app_visitor", "chat_app_id", "visitor_hash"),)


class ConversationMessage(Base):
    __tablename__ = "chat_messages"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id = Column(
        UUID(as_uuid=True), ForeignKey("chat_conversations.id", ondelete="CASCADE"), nullable=False
    )
    role = Column(String(16), nullable=False)  # "user" | "assistant"
    content = Column(Text, nullable=False, default="")
    # Topics the assistant opened to write this reply: [{title, path, url}].
    sources = Column(JSON, nullable=False, default=list)
    # What produced an assistant reply, for operators: provider, model, tool calls, errors.
    details = Column(JSON, nullable=False, default=dict)
    created_at = Column(DateTime(timezone=True), default=_now)

    conversation = relationship("Conversation", back_populates="messages")

    __table_args__ = (Index("ix_chat_messages_conversation", "conversation_id", "created_at"),)
