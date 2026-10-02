"""Request and response shapes for chat apps and transcripts."""

import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional
from urllib.parse import urlparse
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class _Timestamps(BaseModel):
    """Timestamps always leave the API as UTC with an offset.

    SQLite hands datetimes back without their timezone; a bare
    ``2026-09-25T20:29:48`` would be read by browsers as local time.
    """

    @field_validator("created_at", "updated_at", mode="after", check_fields=False)
    @classmethod
    def _utc(cls, value):
        if isinstance(value, datetime) and value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value

_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


class Appearance(BaseModel):
    """How the chat looks and greets people. Every field has a sensible default."""

    model_config = ConfigDict(extra="ignore")

    title: str = Field("Ask the docs", max_length=80)
    subtitle: str = Field("Answers from our documentation", max_length=120)
    welcome_message: str = Field(
        "Hi! Ask me anything about our documentation.", max_length=1000
    )
    input_placeholder: str = Field("Ask a question…", max_length=80)
    suggested_prompts: List[str] = Field(default_factory=list, max_length=6)
    accent_color: str = "#011627"
    position: Literal["right", "left"] = "right"
    show_sources: bool = True

    @field_validator("accent_color")
    @classmethod
    def _hex(cls, value: str) -> str:
        if not _HEX.match(value or ""):
            raise ValueError("Use a six-digit hex colour such as #011627")
        return value.lower()

    @field_validator("suggested_prompts")
    @classmethod
    def _prompts(cls, value: List[str]) -> List[str]:
        cleaned = [p.strip()[:120] for p in value if p and p.strip()]
        return cleaned


_PARAM = re.compile(r"^[A-Za-z0-9_.\-\[\]]{1,40}$")


class SearchSettings(BaseModel):
    """How the search-answers widget finds the query and where it renders."""

    model_config = ConfigDict(extra="ignore")

    # URL parameters (query string, or a #/route?query) that carry the search
    # terms, tried in order. Covers most portals without configuration.
    query_params: List[str] = Field(
        default_factory=lambda: ["q", "query", "search", "searchQuery", "keywords", "term"],
        max_length=10,
    )
    # Where the widget renders: a CSS selector on the portal's search page.
    mount_selector: str = Field("[data-hop-answer]", min_length=1, max_length=200)
    # "prepend" = inside the element, before its content; "before" = as its previous sibling.
    mount_position: Literal["prepend", "append", "before", "after"] = "prepend"
    # Label above an answer.
    heading: str = Field("AI answer", max_length=60)
    # Keyword-style searches ("api tokens") skip the model entirely. Off = the
    # model judges every search, at the cost of a model call per search.
    skip_keyword_searches: bool = True

    @field_validator("query_params")
    @classmethod
    def _params(cls, value: List[str]) -> List[str]:
        cleaned: List[str] = []
        for name in value:
            name = (name or "").strip()
            if not name:
                continue
            if not _PARAM.match(name):
                raise ValueError(f"{name!r} is not a valid URL parameter name")
            if name not in cleaned:
                cleaned.append(name)
        if not cleaned:
            raise ValueError("Give at least one URL parameter name")
        return cleaned

    @field_validator("mount_selector")
    @classmethod
    def _selector(cls, value: str) -> str:
        value = value.strip()
        if "<" in value or "\n" in value:
            raise ValueError("Use a CSS selector such as [data-hop-answer] or #search-results")
        return value


class SearchWidgetIn(BaseModel):
    enabled: bool = False
    settings: SearchSettings = Field(default_factory=SearchSettings)


class SearchWidgetOut(SearchWidgetIn):
    page_url: str
    script_url: str
    embed_snippet: str


def normalize_origin(value: str) -> str:
    """``https://Example.com/path`` → ``https://example.com``."""
    raw = (value or "").strip()
    if raw == "*":
        raise ValueError("Leave the list empty to allow any site, rather than using '*'")
    parsed = urlparse(raw if "://" in raw else f"https://{raw}")
    if parsed.scheme not in ("https", "http") or not parsed.hostname:
        raise ValueError(f"{value!r} is not a site origin such as https://www.example.com")
    host = parsed.hostname.lower()
    if not re.match(r"^(\*\.)?[a-z0-9.-]+$", host):
        raise ValueError(f"{value!r} has an invalid host name")
    port = f":{parsed.port}" if parsed.port else ""
    return f"{parsed.scheme}://{host}{port}"


def clean_origins(value: List[str]) -> List[str]:
    seen: List[str] = []
    for origin in value:
        if not (origin or "").strip():
            continue
        normalized = normalize_origin(origin)
        if normalized not in seen:
            seen.append(normalized)
    return seen


class ChatAppBase(BaseModel):
    description: Optional[str] = Field(None, max_length=2000)
    agent_id: Optional[UUID] = None
    deploy_credential_id: Optional[UUID] = None
    appearance: Appearance = Field(default_factory=Appearance)
    allowed_origins: List[str] = Field(default_factory=list, max_length=50)
    is_active: bool = True
    search: Optional[SearchWidgetIn] = None

    @field_validator("allowed_origins")
    @classmethod
    def _origins(cls, value: List[str]) -> List[str]:
        return clean_origins(value)


class ChatAppCreate(ChatAppBase):
    name: str = Field(..., min_length=1, max_length=255)


class ChatAppUpdate(BaseModel):
    """Partial update: omitted fields are left alone."""

    name: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = Field(None, max_length=2000)
    agent_id: Optional[UUID] = None
    deploy_credential_id: Optional[UUID] = None
    appearance: Optional[Appearance] = None
    allowed_origins: Optional[List[str]] = Field(None, max_length=50)
    is_active: Optional[bool] = None
    search: Optional[SearchWidgetIn] = None

    @field_validator("allowed_origins")
    @classmethod
    def _origins(cls, value: Optional[List[str]]) -> Optional[List[str]]:
        return None if value is None else clean_origins(value)


class AgentRef(BaseModel):
    id: UUID
    name: str
    is_active: bool
    has_ai_configuration: bool
    provider: Optional[str] = None
    model: Optional[str] = None


class DeployCredentialRef(BaseModel):
    id: UUID
    name: str
    organization_id: str = ""
    deployment_id: str = ""
    portal_base_url: str = ""
    audience: str = ""


class ChatAppResponse(_Timestamps):
    id: UUID
    public_id: str
    name: str
    description: Optional[str] = None
    agent_id: Optional[UUID] = None
    agent: Optional[AgentRef] = None
    deploy_credential_id: Optional[UUID] = None
    deploy_credential: Optional[DeployCredentialRef] = None
    appearance: Appearance
    allowed_origins: List[str]
    is_active: bool
    # Why the chat cannot answer yet, if it cannot. Empty when ready.
    problems: List[str] = Field(default_factory=list)
    chat_url: str
    embed_script_url: str
    embed_snippet: str
    search: SearchWidgetOut
    conversation_count: int = 0
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    created_by: Optional[str] = None


class SourceOut(BaseModel):
    title: str
    path: str
    url: Optional[str] = None


class MessageOut(_Timestamps):
    id: UUID
    role: str
    content: str
    sources: List[SourceOut] = Field(default_factory=list)
    # A clarifying question's choices (search answers), shown as one-click replies.
    options: List[str] = Field(default_factory=list)
    created_at: datetime


class OperatorMessageOut(MessageOut):
    details: Dict[str, Any] = Field(default_factory=dict)


class ConversationSummary(_Timestamps):
    id: UUID
    title: str
    message_count: int
    created_at: datetime
    updated_at: Optional[datetime] = None


class OperatorConversationSummary(ConversationSummary):
    origin: Optional[str] = None
    locale: Optional[str] = None
    # Where it started: "chat" (the bubble / chat page) or "search" (search answers).
    surface: str = "chat"
    visitor: str  # a short, stable pseudonym derived from the visitor hash


class ConversationDetail(ConversationSummary):
    messages: List[MessageOut]


class OperatorConversationDetail(OperatorConversationSummary):
    messages: List[OperatorMessageOut]


class ConversationPage(BaseModel):
    items: List[OperatorConversationSummary]
    total: int


# ── Public (visitor) API ──────────────────────────────────────────────────────

class PublicChatConfig(BaseModel):
    # Deliberately not the chat app's name: that is the operator's label.
    public_id: str
    appearance: Appearance
    available: bool
    unavailable_reason: Optional[str] = None


class NewConversation(BaseModel):
    origin: Optional[str] = Field(None, max_length=512)
    locale: Optional[str] = Field(None, max_length=35)


class SearchRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=500)
    locale: Optional[str] = Field(None, max_length=35)
    origin: Optional[str] = Field(None, max_length=512)


class VisitorMessage(BaseModel):
    content: str = Field(..., min_length=1, max_length=4000)
    locale: Optional[str] = Field(None, max_length=35)
