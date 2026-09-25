"""Answering a visitor: chat app + agent + Deploy content → a reply.

Everything the model is told comes from the hop-core agent the chat app points
at — ``AgentDefinition.build_system_prompt()`` — plus the documentation
guidance and tools this app adds. The agent's AI configuration (a hop-core
credential) supplies provider, model and key.
"""

import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, List, Optional

from hop_core.agents import AgentDefinition, AiProviderError
from hop_core.agents.fetcher import fetch_url
from hop_core.ai import ChatMessage
from hop_core.core.security import decrypt_credentials
from hop_core.models.agent import Agent
from hop_core.models.credential import Credential

from app.chat import engine
from app.deploy.client import DeployClient, DeployConfig, DeployError
from app.deploy.credential import DEPLOY_CREDENTIAL_TYPE
from app.deploy.tools import SYSTEM_GUIDANCE, TOOLS, DeployToolbox
from app.models import ChatApp

logger = logging.getLogger(__name__)

# How much history goes up with each message. Older turns are dropped first;
# a documentation chat rarely needs more, and every turn costs tokens.
MAX_HISTORY_MESSAGES = 20

READ_URL_TOOL = {
    "name": "read_url",
    "description": (
        "Fetch the text of a permitted reference URL listed in your instructions. "
        "Only those URLs (and pages beneath them) will succeed."
    ),
    "parameters": {
        "type": "object",
        "properties": {"url": {"type": "string", "description": "The URL to fetch."}},
        "required": ["url"],
    },
}


class ChatUnavailable(RuntimeError):
    """The chat app cannot answer. ``public_message`` is safe to show a visitor."""

    def __init__(self, operator_message: str, public_message: str = "This chat is not available right now."):
        super().__init__(operator_message)
        self.operator_message = operator_message
        self.public_message = public_message


def problems(chat_app: ChatApp) -> List[str]:
    """Everything stopping this chat app from answering, for the operator UI."""
    found: List[str] = []
    if not chat_app.is_active:
        found.append("The chat app is switched off.")
    agent: Optional[Agent] = chat_app.agent
    if agent is None:
        found.append("No agent is selected.")
    else:
        if not agent.is_active:
            found.append(f"The agent “{agent.name}” is inactive.")
        credential = agent.ai_configuration
        if credential is None:
            found.append(f"The agent “{agent.name}” has no AI configuration.")
        elif not engine.is_supported(credential.type):
            found.append(f"The agent's AI provider “{credential.type}” is not supported by chat apps.")
    deploy = chat_app.deploy_credential
    if deploy is None:
        found.append("No Heretto Deploy credential is selected.")
    elif deploy.type != DEPLOY_CREDENTIAL_TYPE:
        found.append("The selected content credential is not a Heretto Deploy credential.")
    return found


@dataclass
class Reply:
    content: str
    sources: List[Dict[str, Any]] = field(default_factory=list)
    details: Dict[str, Any] = field(default_factory=dict)


def _decrypt(credential: Credential, what: str) -> Dict[str, Any]:
    try:
        return decrypt_credentials(credential.encrypted_data)
    except Exception:
        logger.warning("Could not decrypt %s credential %s", what, credential.id, exc_info=True)
        raise ChatUnavailable(f"The {what} credential “{credential.name}” could not be decrypted.")


def summarize_tool_result(name: str, result: str) -> Dict[str, Any]:
    """A short, operator-readable account of what a tool returned."""
    if name == "read_url":
        failed = result.startswith("Could not fetch")
        return {"ok": not failed, "summary": result[:200] if failed else f"{len(result):,} characters of text"}
    try:
        data = json.loads(result)
    except ValueError:
        return {"ok": True, "summary": f"{len(result):,} characters"}
    if isinstance(data, dict) and data.get("error"):
        return {"ok": False, "summary": data["error"]}
    if name == "search_docs":
        hits = data.get("results") or []
        return {
            "ok": True,
            "summary": f"{len(hits)} of {data.get('total_results', len(hits))} results",
            "items": [h.get("title") or h.get("path") for h in hits],
        }
    if name == "read_topic":
        return {
            "ok": True,
            "summary": f"“{data.get('title')}” — {len(data.get('text') or ''):,} characters",
            "items": [data.get("path")],
        }
    if name == "browse_structure":
        def count(node: Any) -> int:
            if isinstance(node, list):
                return sum(count(n) for n in node)
            if isinstance(node, dict):
                return 1 + count(node.get("children") or [])
            return 0
        return {"ok": True, "summary": f"{count(data.get('structure'))} entries in the table of contents"}
    return {"ok": True, "summary": f"{len(result):,} characters"}


def system_prompt(definition: AgentDefinition, deployment_title: Optional[str]) -> str:
    title_clause = f" (“{deployment_title}”)" if deployment_title else ""
    return definition.build_system_prompt() + "\n\n" + SYSTEM_GUIDANCE.format(title_clause=title_clause)


async def answer(
    chat_app: ChatApp,
    history: List[ChatMessage],
    locale: Optional[str] = None,
    on_status: Optional[Callable[[str], Awaitable[None]]] = None,
    transport=None,
    trace: Optional[engine.Tracer] = None,
) -> Reply:
    """Produce the assistant's reply to the last user turn in ``history``.

    ``trace``, when given, receives operator-facing events describing the run
    (model calls, tool calls and their results). It is only wired up for the
    admin Test tab — visitors never see these.
    """

    async def emit(event: Dict[str, Any]) -> None:
        if trace is not None:
            await trace(event)

    found = problems(chat_app)
    if found:
        raise ChatUnavailable(" ".join(found))

    agent: Agent = chat_app.agent
    definition = AgentDefinition.from_model(agent)
    ai_credential: Credential = agent.ai_configuration
    ai_payload = _decrypt(ai_credential, "AI configuration")
    api_key = str(ai_payload.get("api_key") or "")
    model = str(ai_payload.get("model") or "").strip()
    if not api_key:
        raise ChatUnavailable(f"The AI configuration “{ai_credential.name}” has no API key.")

    try:
        deploy_config = DeployConfig.from_payload(_decrypt(chat_app.deploy_credential, "Heretto Deploy"))
    except ValueError as exc:
        raise ChatUnavailable(str(exc))
    client = DeployClient(deploy_config, transport=transport)
    toolbox = DeployToolbox(client=client, locale=locale)

    deployment_title = None
    try:
        deployment_title = (await client.get_deployment()).get("title")
    except DeployError as exc:
        # Not fatal on its own — the tools report their own failures — but worth logging.
        logger.warning("Deploy deployment lookup failed for chat app %s: %s", chat_app.public_id, exc.message)
        await emit({"type": "deploy.error", "message": f"Could not read the deployment: {exc.message}"})

    tools = list(TOOLS)
    if definition.permitted_urls:
        tools.append(READ_URL_TOOL)

    tool_log: List[Dict[str, Any]] = []

    async def execute(name: str, args: Dict[str, Any]) -> str:
        if name == "read_url":
            result = await fetch_url(str(args.get("url") or ""), definition.permitted_urls)
            tool_log.append({"tool": name, "url": result.url, "status": result.status})
            if not result.ok:
                return f"Could not fetch {result.url}: {result.blocked_reason}"
            return result.content or "No readable content."
        tool_log.append({"tool": name, "args": {k: str(v)[:200] for k, v in args.items()}})
        return await toolbox.execute(name, args)

    async def traced_execute(name: str, args: Dict[str, Any]) -> str:
        await emit({"type": "tool.call", "tool": name, "args": args})
        started = time.monotonic()
        result = await execute(name, args)
        await emit({
            "type": "tool.result",
            "tool": name,
            "duration_ms": int((time.monotonic() - started) * 1000),
            **summarize_tool_result(name, result),
        })
        return result

    async def notify(name: str, args: Dict[str, Any]) -> None:
        if on_status is not None:
            label = "Reading a reference page" if name == "read_url" else toolbox.describe(name, args)
            await on_status(label)

    request = engine.EngineRequest(
        provider=ai_credential.type,
        model=model,
        api_key=api_key,
        system_prompt=system_prompt(definition, deployment_title),
        messages=history[-MAX_HISTORY_MESSAGES:],
        tools=tools,
        max_iterations=_max_iterations(),
        trace=trace,
    )
    # A history cut mid-exchange must still open with the visitor's turn.
    while request.messages and request.messages[0].role != "user":
        request.messages.pop(0)

    await emit({
        "type": "run.start",
        "agent": definition.name,
        "ai_configuration": ai_credential.name,
        "provider": ai_credential.type,
        "model": model,
        "deployment": {
            "title": deployment_title,
            "organization_id": deploy_config.organization_id,
            "deployment_id": deploy_config.deployment_id,
            "audience": deploy_config.audience or None,
        },
        "locale": locale,
        "history_messages": len(request.messages),
        "tools": [t["name"] for t in tools],
        "max_tool_rounds": request.max_iterations,
        "system_prompt": request.system_prompt,
    })

    content = await engine.run_conversation(request, traced_execute, notify)
    if not content.strip():
        content = "Sorry — I couldn't put an answer together. Please try rephrasing your question."

    return Reply(
        content=content,
        sources=[{"title": s.title, "path": s.path, "url": s.url} for s in toolbox.sources],
        details={
            "agent": definition.name,
            "provider": ai_credential.type,
            "model": model,
            "ai_configuration": ai_credential.name,
            "tool_calls": tool_log,
        },
    )


def _max_iterations() -> int:
    from hop_core.config import get_settings

    return int(getattr(get_settings(), "chat_max_tool_iterations", 8))


__all__ = ["answer", "problems", "ChatUnavailable", "Reply", "AiProviderError"]
