#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Run as root: sudo ./deploy/pull.sh"
  exit 1
fi

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

if [[ ! -d .git ]]; then
  echo "This folder is not a git checkout. Clone the repo into $APP_DIR first."
  exit 1
fi

if [[ ! -f .env ]]; then
  echo "Missing .env in $APP_DIR. Copy it onto the droplet before updating."
  exit 1
fi

git pull --ff-only
npm ci
npm run build
systemctl restart plaid
systemctl --no-pager --full status plaid
