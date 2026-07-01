#!/bin/bash
# ═══════════════════════════════════════════════════════
#  KageOps — Database Initialization Script
#  Waits for Postgres, runs schema + seed
# ═══════════════════════════════════════════════════════

set -euo pipefail

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-kageops}"
DB_NAME="${DB_NAME:-kageops}"
DB_PASSWORD="${DB_PASSWORD:-kageops_dev_2026}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCHEMA_FILE="${SCRIPT_DIR}/../src/db/schema.sql"
SEED_FILE="${SCRIPT_DIR}/../src/db/seed.sql"

export PGPASSWORD="${DB_PASSWORD}"

echo "╔══════════════════════════════════════╗"
echo "║   KageOps Database Initialization    ║"
echo "╚══════════════════════════════════════╝"
echo ""

# Wait for Postgres to be ready
echo "⏳ Waiting for PostgreSQL at ${DB_HOST}:${DB_PORT}..."
MAX_RETRIES=30
RETRY=0
until pg_isready -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -q 2>/dev/null; do
    RETRY=$((RETRY + 1))
    if [ "${RETRY}" -ge "${MAX_RETRIES}" ]; then
        echo "❌ PostgreSQL did not become ready after ${MAX_RETRIES} attempts."
        exit 1
    fi
    echo "   Attempt ${RETRY}/${MAX_RETRIES} — retrying in 2s..."
    sleep 2
done
echo "✅ PostgreSQL is ready."
echo ""

# Run schema
echo "📋 Running schema.sql..."
psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -f "${SCHEMA_FILE}" 2>&1
echo "✅ Schema applied."
echo ""

# Run seed
echo "🌱 Running seed.sql..."
psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -f "${SEED_FILE}" 2>&1
echo "✅ Seed data inserted."
echo ""

echo "╔══════════════════════════════════════╗"
echo "║   ✅ Database ready for KageOps!     ║"
echo "╚══════════════════════════════════════╝"
