#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Run as root: sudo ./deploy/setup-droplet.sh"
  exit 1
fi

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

if [[ ! -f .env ]]; then
  echo "Missing .env in $APP_DIR. Upload it before running this script."
  exit 1
fi

if [[ ! -f google-service-account.json ]] && ! grep -q '^GOOGLE_SERVICE_ACCOUNT_JSON=.' .env; then
  echo "Missing Google credentials. Upload google-service-account.json or set GOOGLE_SERVICE_ACCOUNT_JSON in .env."
  exit 1
fi

if ! grep -qE '^ADMIN_USERNAME=.+' .env || { ! grep -qE '^ADMIN_PASSWORD=.+' .env && ! grep -qE '^ADMIN_PASSWORD_HASH=.+' .env; }; then
  echo "Set ADMIN_USERNAME and ADMIN_PASSWORD in .env before deploying."
  exit 1
fi

if ! grep -qE '^SESSION_SECRET=.+' .env; then
  echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .env
  echo "Generated SESSION_SECRET in .env"
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl

if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)'; then
  echo "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

if ! id -u plaid >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin plaid
fi

mkdir -p data/pdfs
chmod 700 data
chmod 700 data/pdfs
chmod 600 .env || true
if [[ -f google-service-account.json ]]; then
  chmod 600 google-service-account.json
fi
if [[ -f data/items.json ]]; then
  chmod 600 data/items.json
fi

echo "Installing npm packages..."
npm ci
echo "Building React app..."
npm run build

if [[ -n "${DOMAIN:-}" ]]; then
  if grep -q '^HOST=' .env; then
    sed -i 's/^HOST=.*/HOST=127.0.0.1/' .env
  else
    printf '\nHOST=127.0.0.1\n' >> .env
  fi
  if grep -q '^COOKIE_SECURE=' .env; then
    sed -i 's/^COOKIE_SECURE=.*/COOKIE_SECURE=true/' .env
  else
    printf '\nCOOKIE_SECURE=true\n' >> .env
  fi
fi

NODE_BIN="$(command -v node)"

cat > /etc/systemd/system/plaid.service <<EOF
[Unit]
Description=Plaid Google Sheets sync
After=network.target

[Service]
Type=simple
User=plaid
Group=plaid
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
ExecStart=${NODE_BIN} server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

chown -R plaid:plaid "$APP_DIR"

systemctl daemon-reload
systemctl enable --now plaid
systemctl restart plaid

if [[ -n "${DOMAIN:-}" ]]; then
  echo "Setting up HTTPS for $DOMAIN"
  apt-get install -y nginx certbot python3-certbot-nginx
  sed "s/DOMAIN_NAME/${DOMAIN}/g" "$APP_DIR/deploy/nginx.conf" > /etc/nginx/sites-available/plaid
  ln -sfn /etc/nginx/sites-available/plaid /etc/nginx/sites-enabled/plaid
  rm -f /etc/nginx/sites-enabled/default
  nginx -t
  systemctl enable --now nginx
  systemctl reload nginx
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email || {
    echo "HTTPS cert failed. Point the domain at this droplet and rerun:"
    echo "  sudo DOMAIN=$DOMAIN $APP_DIR/deploy/setup-droplet.sh"
  }
fi

echo
if systemctl is-active --quiet plaid; then
  echo "Plaid service is running."
else
  echo "Plaid service failed to start. Check: journalctl -u plaid -e"
  systemctl --no-pager --full status plaid || true
  exit 1
fi

echo
echo "Open:"
if [[ -n "${DOMAIN:-}" ]]; then
  echo "  https://$DOMAIN"
else
  echo "  http://$(hostname -I | awk '{print $1}'):3000"
fi
echo
echo "Connect each bank once on that URL. Daily sheet updates run at 11:59 AM America/New_York."
echo "Logs: journalctl -u plaid -f"
