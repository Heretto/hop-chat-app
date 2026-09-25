"""Helpers shared by the operator and visitor routes."""

import hashlib
import json
from typing import Optional

from sqlalchemy.orm import Session, joinedload

from hop_core.agents import configurations
from hop_core.core.security import decrypt_credentials
from hop_core.models.agent import Agent
from hop_core.models.credential import Credential

from app.chat.service import problems
from app.models import ChatApp, Conversation
from app.schemas import AgentRef, Appearance, ChatAppResponse, DeployCredentialRef


def public_origin() -> str:
    from hop_core.config import get_settings

    settings = get_settings()
    return (getattr(settings, "public_base_url", None) or settings.frontend_base_url).rstrip("/")


def chat_url(public_id: str) -> str:
    return f"{public_origin()}/c/{public_id}"


def embed_script_url(public_id: str) -> str:
    return f"{public_origin()}/embed/{public_id}.js"


def embed_snippet(public_id: str) -> str:
    return f'<script src="{embed_script_url(public_id)}" async></script>'


def load_chat_app(db: Session, **filters) -> Optional[ChatApp]:
    """A chat app with its agent, AI configuration and Deploy credential loaded."""
    query = db.query(ChatApp).options(
        joinedload(ChatApp.agent).joinedload(Agent.ai_configuration),
        joinedload(ChatApp.agent).selectinload(Agent.context_files),
        joinedload(ChatApp.deploy_credential),
    )
    for key, value in filters.items():
        query = query.filter(getattr(ChatApp, key) == value)
    return query.first()


def appearance_of(chat_app: ChatApp) -> Appearance:
    return Appearance.model_validate(chat_app.appearance or {})


def _agent_ref(agent: Optional[Agent]) -> Optional[AgentRef]:
    if agent is None:
        return None
    described = configurations.describe(agent.ai_configuration)
    return AgentRef(
        id=agent.id,
        name=agent.name,
        is_active=agent.is_active,
        has_ai_configuration=described is not None,
        provider=(described or {}).get("provider"),
        model=(described or {}).get("model"),
    )


def _deploy_ref(credential: Optional[Credential]) -> Optional[DeployCredentialRef]:
    if credential is None:
        return None
    try:
        payload = decrypt_credentials(credential.encrypted_data)
    except Exception:
        payload = {}
    return DeployCredentialRef(
        id=credential.id,
        name=credential.name,
        organization_id=str(payload.get("organization_id") or ""),
        deployment_id=str(payload.get("deployment_id") or ""),
        portal_base_url=str(payload.get("portal_base_url") or ""),
        audience=str(payload.get("audience") or ""),
    )


def serialize_chat_app(chat_app: ChatApp, db: Session) -> ChatAppResponse:
    count = db.query(Conversation).filter(Conversation.chat_app_id == chat_app.id).count()
    return ChatAppResponse(
        id=chat_app.id,
        public_id=chat_app.public_id,
        name=chat_app.name,
        description=chat_app.description,
        agent_id=chat_app.agent_id,
        agent=_agent_ref(chat_app.agent),
        deploy_credential_id=chat_app.deploy_credential_id,
        deploy_credential=_deploy_ref(chat_app.deploy_credential),
        appearance=appearance_of(chat_app),
        allowed_origins=list(chat_app.allowed_origins or []),
        is_active=chat_app.is_active,
        problems=problems(chat_app),
        chat_url=chat_url(chat_app.public_id),
        embed_script_url=embed_script_url(chat_app.public_id),
        embed_snippet=embed_snippet(chat_app.public_id),
        conversation_count=count,
        created_at=chat_app.created_at,
        updated_at=chat_app.updated_at,
        created_by=chat_app.created_by,
    )


def visitor_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def visitor_pseudonym(hash_value: str) -> str:
    """A short, stable label for a visitor in operator views: "Visitor 3f9a1c"."""
    return f"Visitor {hash_value[:6]}"


def json_for_script(value) -> str:
    """JSON safe to embed inside a <script> element."""
    return (
        json.dumps(value, ensure_ascii=False)
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
        .replace(" ", "\\u2028")
        .replace(" ", "\\u2029")
    )
