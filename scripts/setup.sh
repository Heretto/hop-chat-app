#!/usr/bin/env bash
# Generate backend/.env with fresh secrets. Never overwrites an existing one:
# ENCRYPTION_KEY encrypts every stored credential and cannot be rotated.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$ROOT_DIR/backend/.env"

if [ -f "$ENV_FILE" ]; then
    echo ".env already exists at $ENV_FILE"
    echo "Delete it and re-run to regenerate secrets (stored credentials become unreadable)."
    exit 0
fi

if ! command -v python3 &>/dev/null; then
    echo "Error: python3 is required to generate secrets."
    exit 1
fi

echo "Generating secrets..."

APP_SECRET=$(python3 -c "import secrets; print(secrets.token_urlsafe(32))")
JWT_SECRET=$(python3 -c "import secrets; print(secrets.token_urlsafe(32))")
ENC_KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(32))")

cat > "$ENV_FILE" <<EOF
APP_ENV=development
APP_DEBUG=false

DATABASE_URL=sqlite:///./hop-chat.db

APP_SECRET_KEY=$APP_SECRET
JWT_SECRET_KEY=$JWT_SECRET
ENCRYPTION_KEY=$ENC_KEY

# The origin visitors' browsers reach the chat on; embed snippets and chat URLs
# are built from it. ./dev.sh overrides these three with the port it picks.
PUBLIC_BASE_URL=http://localhost:4200
FRONTEND_BASE_URL=http://localhost:4200
CORS_ORIGINS=http://localhost:4200

PUBLIC_MESSAGE_RATE_LIMIT=20/minute
EOF

echo "Created $ENV_FILE"
echo "Back up ENCRYPTION_KEY somewhere safe — it cannot be changed later."
