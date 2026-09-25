"""Tool-calling conversation loop over the AI configuration an agent selects.

hop-core's providers run a tool loop with one fixed tool (``read_url``). A
documentation chat needs the Deploy tools as well, so this module runs the
same kind of loop with an arbitrary tool list — one implementation per
provider hop-core ships an AI configuration type for (Anthropic, OpenAI,
Gemini), using the same endpoints and error conventions as
``hop_core.agents.providers``.

The system prompt is still the agent's own: ``AgentDefinition
.build_system_prompt()`` composes it, and the chat app only appends its
answering guidance. Configuring the agent in hop-core's agent editor is how an
operator configures the chat.
"""

import json
import logging
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, List, Optional

import httpx
from hop_core.agents import AiProviderError
from hop_core.ai import ChatMessage

logger = logging.getLogger(__name__)

GENERATION_TIMEOUT_SECONDS = 120.0
DEFAULT_MAX_TOKENS = 2048

ToolExecutor = Callable[[str, Dict[str, Any]], Awaitable[str]]
ToolNotifier = Callable[[str, Dict[str, Any]], Awaitable[None]]
# Receives operator-facing trace events (see _model_call / _model_done).
Tracer = Callable[[Dict[str, Any]], Awaitable[None]]


@dataclass
class EngineRequest:
    provider: str
    model: str
    api_key: str
    system_prompt: str
    messages: List[ChatMessage]
    tools: List[Dict[str, Any]]
    max_tokens: int = DEFAULT_MAX_TOKENS
    temperature: Optional[float] = None
    max_iterations: int = 8
    trace: Optional[Tracer] = None


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=GENERATION_TIMEOUT_SECONDS, follow_redirects=False)


def _fail(provider: str, response: httpx.Response) -> AiProviderError:
    detail = ""
    try:
        error = response.json().get("error")
        if isinstance(error, dict):
            detail = error.get("message") or ""
        elif isinstance(error, str):
            detail = error
    except Exception:
        detail = (response.text or "")[:300]
    suffix = f": {detail}" if detail else "."
    return AiProviderError(
        f"{provider} returned HTTP {response.status_code}{suffix}",
        status_code=response.status_code,
    )


async def _emit(req: EngineRequest, event: Dict[str, Any]) -> None:
    if req.trace is not None:
        await req.trace(event)


async def _model_call(req: EngineRequest, iteration: int, last: bool, turns: int) -> float:
    await _emit(req, {
        "type": "model.request",
        "iteration": iteration + 1,
        "messages": turns,
        "tools_allowed": not last,
        "provider": req.provider,
        "model": req.model,
    })
    return time.monotonic()


async def _model_done(
    req: EngineRequest,
    iteration: int,
    started: float,
    stop_reason: Optional[str],
    usage: Dict[str, Any],
    text: str,
    tool_calls: List[Dict[str, Any]],
) -> None:
    await _emit(req, {
        "type": "model.response",
        "iteration": iteration + 1,
        "duration_ms": int((time.monotonic() - started) * 1000),
        "stop_reason": stop_reason,
        "input_tokens": usage.get("input"),
        "output_tokens": usage.get("output"),
        "text": text[:2000],
        "tool_calls": tool_calls,
    })


async def _model_failed(req: EngineRequest, iteration: int, started: float, error: AiProviderError) -> None:
    await _emit(req, {
        "type": "model.error",
        "iteration": iteration + 1,
        "duration_ms": int((time.monotonic() - started) * 1000),
        "message": error.message,
    })


_WRAP_UP = (
    "You have used all the tool calls available for this message. Answer now from "
    "what you have already retrieved."
)


# ── Anthropic ─────────────────────────────────────────────────────────────────

async def _run_anthropic(req: EngineRequest, execute: ToolExecutor, notify: ToolNotifier) -> str:
    tools = [
        {"name": t["name"], "description": t["description"], "input_schema": t["parameters"]}
        for t in req.tools
    ]
    messages: List[Dict[str, Any]] = [{"role": m.role, "content": m.content} for m in req.messages]
    headers = {
        "x-api-key": req.api_key,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
    }

    async with _client() as client:
        for iteration in range(req.max_iterations + 1):
            last = iteration == req.max_iterations
            body: Dict[str, Any] = {
                "model": req.model,
                "max_tokens": req.max_tokens,
                "system": req.system_prompt + ("\n\n" + _WRAP_UP if last else ""),
                "messages": messages,
            }
            # Tools stay declared — a history holding tool_use blocks must — but
            # the wrap-up turn is not allowed to call them.
            body["tools"] = tools
            if last:
                body["tool_choice"] = {"type": "none"}
            if req.temperature is not None:
                body["temperature"] = req.temperature

            started = await _model_call(req, iteration, last, len(messages))
            response = await client.post(
                "https://api.anthropic.com/v1/messages", headers=headers, json=body
            )
            if response.status_code != 200:
                error = _fail("Anthropic", response)
                await _model_failed(req, iteration, started, error)
                raise error

            data = response.json()
            blocks = data.get("content") or []
            usage = data.get("usage") or {}
            text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
            await _model_done(
                req, iteration, started, data.get("stop_reason"),
                {"input": usage.get("input_tokens"), "output": usage.get("output_tokens")},
                text,
                [{"name": b.get("name"), "args": b.get("input") or {}} for b in blocks if b.get("type") == "tool_use"],
            )
            if data.get("stop_reason") != "tool_use":
                return text

            messages.append({"role": "assistant", "content": blocks})
            results = []
            for block in blocks:
                if block.get("type") == "tool_use":
                    args = block.get("input") or {}
                    await notify(block["name"], args)
                    results.append({
                        "type": "tool_result",
                        "tool_use_id": block["id"],
                        "content": await execute(block["name"], args),
                    })
            messages.append({"role": "user", "content": results})
    return ""


# ── OpenAI ────────────────────────────────────────────────────────────────────

async def _run_openai(req: EngineRequest, execute: ToolExecutor, notify: ToolNotifier) -> str:
    tools = [
        {"type": "function", "function": {
            "name": t["name"], "description": t["description"], "parameters": t["parameters"],
        }}
        for t in req.tools
    ]
    messages: List[Dict[str, Any]] = [{"role": "system", "content": req.system_prompt}]
    messages += [{"role": m.role, "content": m.content} for m in req.messages]
    url = "https://api.openai.com/v1/chat/completions"
    headers = {"Authorization": f"Bearer {req.api_key}", "Content-Type": "application/json"}
    token_param = "max_completion_tokens"

    async with _client() as client:
        for iteration in range(req.max_iterations + 1):
            last = iteration == req.max_iterations
            body: Dict[str, Any] = {
                "model": req.model, "messages": messages, token_param: req.max_tokens, "tools": tools,
            }
            if last:
                body["messages"] = messages + [{"role": "system", "content": _WRAP_UP}]
                body["tool_choice"] = "none"
            if req.temperature is not None:
                body["temperature"] = req.temperature

            started = await _model_call(req, iteration, last, len(messages))
            response = await client.post(url, headers=headers, json=body)
            # Older models want max_tokens instead.
            if response.status_code == 400 and "max_completion_tokens" in response.text:
                token_param = "max_tokens"
                body["max_tokens"] = body.pop("max_completion_tokens")
                response = await client.post(url, headers=headers, json=body)
            if response.status_code != 200:
                error = _fail("OpenAI", response)
                await _model_failed(req, iteration, started, error)
                raise error

            payload = response.json()
            choice = (payload.get("choices") or [{}])[0]
            message = choice.get("message") or {}
            calls = message.get("tool_calls") or []
            usage = payload.get("usage") or {}

            def _args(call: Dict[str, Any]) -> Dict[str, Any]:
                try:
                    return json.loads((call.get("function") or {}).get("arguments") or "{}")
                except ValueError:
                    return {}

            await _model_done(
                req, iteration, started, choice.get("finish_reason"),
                {"input": usage.get("prompt_tokens"), "output": usage.get("completion_tokens")},
                message.get("content") or "",
                [{"name": (c.get("function") or {}).get("name"), "args": _args(c)} for c in calls],
            )
            if not calls:
                return message.get("content") or ""

            messages.append(message)
            for call in calls:
                fn = call.get("function") or {}
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except ValueError:
                    args = {}
                await notify(fn.get("name", ""), args)
                messages.append({
                    "role": "tool",
                    "tool_call_id": call["id"],
                    "content": await execute(fn.get("name", ""), args),
                })
    return ""


# ── Google Gemini ─────────────────────────────────────────────────────────────

async def _run_gemini(req: EngineRequest, execute: ToolExecutor, notify: ToolNotifier) -> str:
    tools = [{"functionDeclarations": [
        {"name": t["name"], "description": t["description"], "parameters": t["parameters"]}
        for t in req.tools
    ]}]
    contents: List[Dict[str, Any]] = [
        {"role": "model" if m.role == "assistant" else "user", "parts": [{"text": m.content}]}
        for m in req.messages
    ]
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{req.model}:generateContent"
    headers = {"x-goog-api-key": req.api_key, "Content-Type": "application/json"}

    async with _client() as client:
        for iteration in range(req.max_iterations + 1):
            last = iteration == req.max_iterations
            system = req.system_prompt + ("\n\n" + _WRAP_UP if last else "")
            body: Dict[str, Any] = {
                "contents": contents,
                "systemInstruction": {"parts": [{"text": system}]},
                "generationConfig": {"maxOutputTokens": req.max_tokens},
            }
            body["tools"] = tools
            if last:
                body["toolConfig"] = {"functionCallingConfig": {"mode": "NONE"}}
            if req.temperature is not None:
                body["generationConfig"]["temperature"] = req.temperature

            started = await _model_call(req, iteration, last, len(contents))
            response = await client.post(url, headers=headers, json=body)
            if response.status_code != 200:
                error = _fail("Google Gemini", response)
                await _model_failed(req, iteration, started, error)
                raise error

            payload = response.json()
            candidates = payload.get("candidates") or [{}]
            parts = (candidates[0].get("content") or {}).get("parts") or []
            calls = [p["functionCall"] for p in parts if "functionCall" in p]
            usage = payload.get("usageMetadata") or {}
            text = "".join(p.get("text", "") for p in parts)
            await _model_done(
                req, iteration, started, candidates[0].get("finishReason"),
                {"input": usage.get("promptTokenCount"), "output": usage.get("candidatesTokenCount")},
                text,
                [{"name": c.get("name"), "args": c.get("args") or {}} for c in calls],
            )
            if not calls:
                return text

            contents.append({"role": "model", "parts": parts})
            replies = []
            for call in calls:
                args = call.get("args") or {}
                await notify(call["name"], args)
                result = await execute(call["name"], args)
                replies.append({"functionResponse": {"name": call["name"], "response": {"result": result}}})
            contents.append({"role": "user", "parts": replies})
    return ""


RUNNERS = {
    "anthropic": _run_anthropic,
    "openai": _run_openai,
    "gemini": _run_gemini,
}


def is_supported(provider: str) -> bool:
    return provider in RUNNERS


async def run_conversation(
    req: EngineRequest,
    execute: ToolExecutor,
    notify: Optional[ToolNotifier] = None,
) -> str:
    """Run the conversation to a final assistant reply."""
    runner = RUNNERS.get(req.provider)
    if runner is None:
        raise AiProviderError(
            f"Chat apps do not support the {req.provider!r} provider. "
            f"Use one of: {', '.join(sorted(RUNNERS))}."
        )
    if not req.model:
        raise AiProviderError("This AI configuration does not name a model. Set one on the credential.")

    async def _noop(name: str, args: Dict[str, Any]) -> None:
        return None

    logger.debug("Chat run on %s/%s", req.provider, req.model)
    return await runner(req, execute, notify or _noop)
