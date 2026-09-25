"""Trace tokens: let the admin Test tab see what the agent is doing.

A test session gets a short-lived token, signed with the app secret and bound
to one chat app. The chat page sends it back with each message
(``X-Hop-Trace``), and only then does the reply stream carry ``trace`` events:
model calls, tool calls and their results, and the operator's version of any
error. Visitors never hold a token, so they never see any of it.
"""

from typing import Optional
from uuid import UUID

from itsdangerous import BadSignature, URLSafeTimedSerializer

TRACE_TOKEN_MAX_AGE = 8 * 60 * 60  # a working day of testing
_SALT = "hop-chat-trace-v1"


def _serializer() -> URLSafeTimedSerializer:
    from hop_core.config import get_settings

    return URLSafeTimedSerializer(get_settings().app_secret_key, salt=_SALT)


def issue(chat_app_id: UUID) -> str:
    return _serializer().dumps({"chat_app": str(chat_app_id)})


def verify(token: Optional[str], chat_app_id: UUID) -> bool:
    if not token:
        return False
    try:
        data = _serializer().loads(token, max_age=TRACE_TOKEN_MAX_AGE)
    except BadSignature:  # also covers SignatureExpired
        return False
    return isinstance(data, dict) and data.get("chat_app") == str(chat_app_id)
