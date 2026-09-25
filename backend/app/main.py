"""HOP Chat — embeddable documentation chat built on hop-core.

hop-core supplies auth, organizations, encrypted credentials and agents (with
its agent editor UI). This app adds chat apps: an agent + a Heretto Deploy
deployment + presentation, served to visitors through a one-line embed.
"""

from fastapi.responses import JSONResponse
from sqlalchemy import text

from hop_core.app_factory import create_hop_app
from hop_core.credentials import AI_PROVIDER_TYPES, register_builtin_types
from hop_core.db import get_session_factory

import app.models  # noqa: F401 — registers this app's tables before startup create_all
from app.deploy.credential import register_deploy_credential_type
from app.middleware import PublicPathMiddleware
from app.routes import chat_apps, public, widget
from app.settings import get_settings

__version__ = "0.1.0"

# The credential types this app offers: the AI providers an agent's model
# configuration is chosen from, and the Deploy deployment a chat answers from.
register_builtin_types(*AI_PROVIDER_TYPES)
register_deploy_credential_type()

app = create_hop_app(
    settings_factory=get_settings,
    title="HOP Chat",
    description="Embeddable chat over Heretto Deploy content, configured with hop-core agents",
    version=__version__,
    extra_routers=[chat_apps.router, public.router],
)

# Outside the API prefix: pages and scripts a visitor's browser loads directly.
app.include_router(widget.router)
app.add_middleware(PublicPathMiddleware, api_prefix=get_settings().api_prefix)


@app.get("/api/health", include_in_schema=False)
async def health():
    """Unauthenticated health check (hop-core deliberately provides none)."""
    db = get_session_factory()()
    try:
        db.execute(text("SELECT 1"))
        return {"status": "ok", "version": __version__}
    except Exception:
        return JSONResponse({"status": "degraded", "detail": "database unreachable"}, status_code=503)
    finally:
        db.close()
