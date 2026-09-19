#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: ./deploy/upload.sh user@your-droplet-ip [remote-dir]"
  echo "Example: ./deploy/upload.sh root@167.99.0.1"
  exit 1
fi

TARGET="$1"
REMOTE_DIR="${2:-/opt/plaid}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "Uploading $ROOT_DIR -> $TARGET:$REMOTE_DIR"

ssh "$TARGET" "mkdir -p '$REMOTE_DIR'"

rsync -avz \
  --exclude node_modules \
  --exclude .git \
  --exclude .DS_Store \
  --exclude 'data/items.json' \
  "$ROOT_DIR/" "$TARGET:$REMOTE_DIR/"

echo
echo "Uploaded. On the droplet run:"
echo "  cd $REMOTE_DIR && sudo ./deploy/setup-droplet.sh"
echo
echo "If you already connected banks locally and want to keep them:"
echo "  rsync -avz $ROOT_DIR/data/items.json $TARGET:$REMOTE_DIR/data/items.json"
echo "Then on the droplet: sudo systemctl restart plaid"
