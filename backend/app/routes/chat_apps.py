"""Operator routes: manage chat apps and read their transcripts.

Organization-scoped like hop-core's own agent routes — every query is filtered
by the caller's current organization, and anything outside it is a 404.
"""

from typing import List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from hop_core.api.dependencies import CurrentUserContext, get_current_active_user_with_org
from hop_core.db import get_db
from hop_core.models.agent import Agent
from hop_core.models.credential import Credential

from app import trace
from app.deploy.credential import DEPLOY_CREDENTIAL_TYPE
from app.models import ChatApp, Conversation, new_public_id
from app.routes.common import load_chat_app, serialize_chat_app, visitor_pseudonym
from app.schemas import (
    ChatAppCreate,
    ChatAppResponse,
    ChatAppUpdate,
    ConversationPage,
    OperatorConversationDetail,
    OperatorConversationSummary,
    OperatorMessageOut,
)

router = APIRouter(prefix="/chat-apps", tags=["chat-apps"])


def _owned(chat_app_id: UUID, context: CurrentUserContext, db: Session) -> ChatApp:
    chat_app = load_chat_app(db, id=chat_app_id, organization_id=context.organization_id)
    if chat_app is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat app not found")
    return chat_app


def _check_references(
    db: Session,
    organization_id: UUID,
    agent_id: Optional[UUID],
    deploy_credential_id: Optional[UUID],
) -> None:
    if agent_id is not None:
        agent = db.query(Agent).filter(
            Agent.id == agent_id, Agent.organization_id == organization_id
        ).first()
        if agent is None:
            raise HTTPException(status_code=400, detail="That agent does not exist in this organization.")
    if deploy_credential_id is not None:
        credential = db.query(Credential).filter(
            Credential.id == deploy_credential_id,
            Credential.organization_id == organization_id,
        ).first()
        if credential is None or credential.type != DEPLOY_CREDENTIAL_TYPE:
            raise HTTPException(
                status_code=400, detail="Select a Heretto Deploy credential from this organization."
            )


def _unique_name(db: Session, organization_id: UUID, name: str, exclude: Optional[UUID] = None) -> None:
    query = db.query(ChatApp).filter(
        ChatApp.organization_id == organization_id, ChatApp.name == name
    )
    if exclude is not None:
        query = query.filter(ChatApp.id != exclude)
    if query.first() is not None:
        raise HTTPException(status_code=400, detail=f"A chat app named “{name}” already exists.")


@router.get("/", response_model=List[ChatAppResponse])
async def list_chat_apps(
    context: CurrentUserContext = Depends(get_current_active_user_with_org),
    db: Session = Depends(get_db),
):
    ids = [
        row.id for row in db.query(ChatApp.id)
        .filter(ChatApp.organization_id == context.organization_id)
        .order_by(ChatApp.name)
    ]
    return [serialize_chat_app(load_chat_app(db, id=i), db) for i in ids]


@router.post("/", response_model=ChatAppResponse, status_code=status.HTTP_201_CREATED)
async def create_chat_app(
    data: ChatAppCreate,
    context: CurrentUserContext = Depends(get_current_active_user_with_org),
    db: Session = Depends(get_db),
):
    name = data.name.strip()
    _unique_name(db, context.organization_id, name)
    _check_references(db, context.organization_id, data.agent_id, data.deploy_credential_id)

    public_id = new_public_id()
    while db.query(ChatApp).filter(ChatApp.public_id == public_id).first() is not None:
        public_id = new_public_id()

    chat_app = ChatApp(
        organization_id=context.organization_id,
        public_id=public_id,
        name=name,
        description=data.description,
        agent_id=data.agent_id,
        deploy_credential_id=data.deploy_credential_id,
        appearance=data.appearance.model_dump(),
        allowed_origins=data.allowed_origins,
        is_active=data.is_active,
        created_by=context.user.email,
    )
    db.add(chat_app)
    db.commit()
    return serialize_chat_app(_owned(chat_app.id, context, db), db)


@router.get("/{chat_app_id}", response_model=ChatAppResponse)
async def get_chat_app(
    chat_app_id: UUID,
    context: CurrentUserContext = Depends(get_current_active_user_with_org),
    db: Session = Depends(get_db),
):
    return serialize_chat_app(_owned(chat_app_id, context, db), db)


@router.put("/{chat_app_id}", response_model=ChatAppResponse)
async def update_chat_app(
    chat_app_id: UUID,
    data: ChatAppUpdate,
    context: CurrentUserContext = Depends(get_current_active_user_with_org),
    db: Session = Depends(get_db),
):
    chat_app = _owned(chat_app_id, context, db)
    changes = data.model_dump(exclude_unset=True)

    if "name" in changes and changes["name"] is not None:
        changes["name"] = changes["name"].strip()
        _unique_name(db, context.organization_id, changes["name"], exclude=chat_app.id)
    _check_references(
        db, context.organization_id, changes.get("agent_id"), changes.get("deploy_credential_id")
    )
    if "appearance" in changes and data.appearance is not None:
        changes["appearance"] = data.appearance.model_dump()

    for key, value in changes.items():
        if key == "name" and value is None:
            continue
        setattr(chat_app, key, value)
    db.commit()
    db.expire_all()
    return serialize_chat_app(_owned(chat_app_id, context, db), db)


@router.post("/{chat_app_id}/rotate-public-id", response_model=ChatAppResponse)
async def rotate_public_id(
    chat_app_id: UUID,
    context: CurrentUserContext = Depends(get_current_active_user_with_org),
    db: Session = Depends(get_db),
):
    """Issue a new public URL. Every existing embed and link stops working."""
    chat_app = _owned(chat_app_id, context, db)
    chat_app.public_id = new_public_id()
    db.commit()
    return serialize_chat_app(_owned(chat_app_id, context, db), db)


@router.post("/{chat_app_id}/test-session")
async def start_test_session(
    chat_app_id: UUID,
    context: CurrentUserContext = Depends(get_current_active_user_with_org),
    db: Session = Depends(get_db),
):
    """A trace token for the Test tab: replies sent with it include agent trace events."""
    chat_app = _owned(chat_app_id, context, db)
    return {"trace_token": trace.issue(chat_app.id), "expires_in": trace.TRACE_TOKEN_MAX_AGE}


@router.delete("/{chat_app_id}")
async def delete_chat_app(
    chat_app_id: UUID,
    context: CurrentUserContext = Depends(get_current_active_user_with_org),
    db: Session = Depends(get_db),
):
    chat_app = _owned(chat_app_id, context, db)
    db.delete(chat_app)
    db.commit()
    return {"message": "Chat app deleted"}


# ── Transcripts ───────────────────────────────────────────────────────────────

def _summary(conversation: Conversation) -> OperatorConversationSummary:
    return OperatorConversationSummary(
        id=conversation.id,
        title=conversation.title,
        message_count=conversation.message_count,
        created_at=conversation.created_at,
        updated_at=conversation.updated_at,
        origin=conversation.origin,
        locale=conversation.locale,
        visitor=visitor_pseudonym(conversation.visitor_hash),
    )


@router.get("/{chat_app_id}/conversations/", response_model=ConversationPage)
async def list_conversations(
    chat_app_id: UUID,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    context: CurrentUserContext = Depends(get_current_active_user_with_org),
    db: Session = Depends(get_db),
):
    chat_app = _owned(chat_app_id, context, db)
    query = db.query(Conversation).filter(Conversation.chat_app_id == chat_app.id)
    total = query.count()
    rows = query.order_by(Conversation.updated_at.desc()).offset(offset).limit(limit).all()
    return ConversationPage(items=[_summary(c) for c in rows], total=total)


def _owned_conversation(chat_app: ChatApp, conversation_id: UUID, db: Session) -> Conversation:
    conversation = db.query(Conversation).filter(
        Conversation.id == conversation_id, Conversation.chat_app_id == chat_app.id
    ).first()
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conversation


@router.get("/{chat_app_id}/conversations/{conversation_id}", response_model=OperatorConversationDetail)
async def get_conversation(
    chat_app_id: UUID,
    conversation_id: UUID,
    context: CurrentUserContext = Depends(get_current_active_user_with_org),
    db: Session = Depends(get_db),
):
    conversation = _owned_conversation(_owned(chat_app_id, context, db), conversation_id, db)
    return OperatorConversationDetail(
        **_summary(conversation).model_dump(),
        messages=[
            OperatorMessageOut(
                id=m.id, role=m.role, content=m.content, sources=m.sources or [],
                details=m.details or {}, created_at=m.created_at,
            )
            for m in conversation.messages
        ],
    )


@router.delete("/{chat_app_id}/conversations/{conversation_id}")
async def delete_conversation(
    chat_app_id: UUID,
    conversation_id: UUID,
    context: CurrentUserContext = Depends(get_current_active_user_with_org),
    db: Session = Depends(get_db),
):
    conversation = _owned_conversation(_owned(chat_app_id, context, db), conversation_id, db)
    db.delete(conversation)
    db.commit()
    return {"message": "Conversation deleted"}
