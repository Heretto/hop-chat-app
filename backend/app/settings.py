"""Application settings.

Extends hop-core's settings with what the chat app needs. The required
hop-core secrets (APP_SECRET_KEY, JWT_SECRET_KEY, ENCRYPTION_KEY,
DATABASE_URL) have no defaults on purpose — see hop-core AGENTS.md §3.
"""

from functools import lru_cache
from pathlib import Path
from typing import Optional

from hop_core.config import HopCoreSettings

# backend/.env — read when running uvicorn locally. Docker Compose reads the
# repo-root .env instead and passes values in as environment variables.
_ENV_FILE = str(Path(__file__).resolve().parent.parent / ".env")


class AppSettings(HopCoreSettings):
    # Declared required by hop-core but unused here.
    redis_url: str = ""

    # The public origin the widget and chat pages are served from, as seen by
    # visitors' browsers. Embed snippets and chat-page links are built from it.
    # Falls back to FRONTEND_BASE_URL.
    public_base_url: Optional[str] = None

    # Per-IP limit on visitor messages. Every message is a paid model call.
    public_message_rate_limit: str = "20/minute"

    # How many tool round-trips one visitor message may take.
    chat_max_tool_iterations: int = 8

    class Config(HopCoreSettings.Config):
        env_file = _ENV_FILE
        case_sensitive = False
        extra = "ignore"

    @property
    def public_origin(self) -> str:
        return (self.public_base_url or self.frontend_base_url).rstrip("/")


@lru_cache
def get_settings() -> AppSettings:
    return AppSettings()
