# Plaid bank totals → Google Sheets

Connect banks with Plaid, then write daily totals into Google Sheets. The sheet uses one tab per month (`Sept 2026`, `Oct 2026`, …) and one date column per day, with the newest date on the left.

## What you need

- Node.js 18 or later
- A Plaid account (`PLAID_CLIENT_ID`, `PLAID_SECRET`)
- A Google Sheet shared with your service account as **Editor**
- The Google service account JSON key

## Local run

```bash
npm install
cp .env.example .env
```

Put your secrets in `.env`, including login:

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=choose-a-strong-password
SESSION_SECRET=long-random-string
```

Save the Google key as `google-service-account.json` in this folder. Then:

```bash
npm run build
npm start
```

Open http://localhost:3000, sign in, connect each bank once, then click **Send to Google Sheets**. Connected banks are saved in `data/items.json` so they survive restarts.

To work on the React UI with live reload, run `npm start` and `npm run dev:client` together, then open http://localhost:5173.

## Daily update at 11:59 AM

While `node server.js` is running, the app syncs every connected bank and updates the sheet **every day at 11:59 AM**.

Default timezone is `America/New_York` (US Eastern). Change it with:

```env
TZ=America/New_York
DAILY_SYNC_ENABLED=true
DAILY_SYNC_CRON=59 11 * * *
```

Other US options: `America/Chicago`, `America/Denver`, `America/Los_Angeles`.

When a month ends, the first run in the new month also saves the finished tab as a PDF (`Sept 2026.pdf`, then `Oct 2026.pdf`, and so on). It tries to put that file next to your spreadsheet in Google Drive, and keeps a copy in `data/pdfs/` on the server. Enable the **Google Drive API** on the same Google Cloud project as the service account. Optional:

```env
GOOGLE_PDF_FOLDER_ID=
GOOGLE_PDF_SHARE_EMAIL=
```

Run one update immediately:

```bash
node server.js --daily
```

If you prefer OS cron instead of the built-in schedule, set `DAILY_SYNC_ENABLED=false` and add:

```cron
59 11 * * * cd /opt/plaid && /usr/bin/node server.js --daily
```

## Deploy on DigitalOcean (Droplet)

Use a **Droplet**, not App Platform. This app saves connected banks in `data/items.json`, and App Platform disks are wiped on every deploy.

Keep the GitHub repo **private**. Never commit `.env` or `google-service-account.json`.

### 1. Create the Droplet

1. Create an Ubuntu Droplet (1 GB is enough). Give it a domain if you want HTTPS, such as `banks.example.com`.
2. In the DigitalOcean firewall, allow SSH (22). For HTTPS also allow 80 and 443. For a quick HTTP test, allow 3000.
3. Put production values in local `.env`:

```env
PLAID_ENV=production
PLAID_REDIRECT_URI=https://banks.example.com/
TZ=America/New_York
DAILY_SYNC_ENABLED=true
ADMIN_USERNAME=admin
ADMIN_PASSWORD=choose-a-strong-password
SESSION_SECRET=long-random-string
IS_ADMIN=true
```

4. In the Plaid Dashboard, add that same redirect URI and your live site origin.

### 2. Clone from GitHub, then copy secrets

On the Droplet:

```bash
apt-get update && apt-get install -y git
git clone git@github.com:YOUR_GITHUB_USER/YOUR_REPO.git /opt/plaid
```

From your laptop, copy only the secret files (not the whole project):

```bash
scp .env google-service-account.json root@YOUR_DROPLET_IP:/opt/plaid/
```

Then on the Droplet:

```bash
cd /opt/plaid
chmod +x deploy/setup-droplet.sh deploy/pull.sh
sudo ./deploy/setup-droplet.sh
```

The script installs Node.js, installs packages, builds the React app, and starts a systemd service named `plaid`.

To update later after you push to GitHub:

```bash
ssh root@YOUR_DROPLET_IP
cd /opt/plaid
sudo ./deploy/pull.sh
```

### Optional: upload without git

```bash
chmod +x deploy/upload.sh deploy/setup-droplet.sh
./deploy/upload.sh root@YOUR_DROPLET_IP
```

That copies `.env` and `google-service-account.json`. Do not commit those files.

HTTP test URL: `http://YOUR_DROPLET_IP:3000`

For HTTPS with a domain pointed at the Droplet:

```bash
cd /opt/plaid
sudo DOMAIN=banks.example.com ./deploy/setup-droplet.sh
```

Then open `https://banks.example.com`, **sign in**, connect each bank once, and click **Send to Google Sheets**. The daily job keeps running at 11:59 AM US Eastern as long as the service is up.

Useful commands:

```bash
sudo systemctl status plaid
sudo journalctl -u plaid -f
sudo systemctl restart plaid
```

On hosts without a key file, paste the JSON into `GOOGLE_SERVICE_ACCOUNT_JSON` instead of using `google-service-account.json`.

## Production Plaid notes

- Set `PLAID_ENV=production` and use the production secret.
- For OAuth banks such as Chase, set `PLAID_REDIRECT_URI` to your public HTTPS URL and allowlist that URL in the Plaid Dashboard.

## Security

The dashboard is behind a username and password. Sessions use an httpOnly cookie. Bank `access_token` values and `PLAID_SECRET` stay on the server.

Never expose these to the browser:

- `PLAID_SECRET`
- `access_token`
- `ADMIN_PASSWORD`
- `SESSION_SECRET`
- `google-service-account.json`
- `data/items.json`

Optional: set `DAILY_SYNC_SECRET` and send it as header `x-sync-secret` when calling `POST /api/daily_sync`. If that secret is unset, daily_sync also requires a signed-in session.
