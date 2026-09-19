import { useEffect, useState } from 'react';
import { getSettings, saveSettings } from './api.js';

const TIMEZONES = [
  { value: 'America/New_York', label: 'Eastern (America/New_York)' },
  { value: 'America/Chicago', label: 'Central (America/Chicago)' },
  { value: 'America/Denver', label: 'Mountain (America/Denver)' },
  { value: 'America/Los_Angeles', label: 'Pacific (America/Los_Angeles)' },
  { value: 'America/Phoenix', label: 'Arizona (America/Phoenix)' },
  { value: 'UTC', label: 'UTC' },
];

const EMPTY = {
  PLAID_ENV: 'sandbox',
  PLAID_REDIRECT_URI: '',
  GOOGLE_SHEETS_SPREADSHEET_ID: '',
  TZ: 'America/New_York',
  DAILY_SYNC_ENABLED: 'true',
  DAILY_SYNC_CRON: '59 11 * * *',
  GOOGLE_PDF_FOLDER_ID: '',
  GOOGLE_PDF_SHARE_EMAIL: '',
};

export default function Settings({ onSaved }) {
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await getSettings();
        if (!cancelled) setForm({ ...EMPTY, ...(data.settings || {}) });
      } catch (error) {
        if (!cancelled) setMessage({ type: 'error', text: error.message });
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function update(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const result = await saveSettings(form);
      setForm({ ...EMPTY, ...(result.settings || {}) });
      setMessage({ type: 'success', text: 'Settings saved.' });
      if (onSaved) await onSaved(result);
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h1>Settings</h1>
      <p className="subtitle">
        These are the non-secret options. Plaid secret, login password, session secret, and Google
        service account keys stay on the server in `.env` only.
      </p>

      <form className="settings-form" onSubmit={handleSubmit}>
        <label>
          Plaid environment
          <select
            value={form.PLAID_ENV || 'sandbox'}
            onChange={(event) => update('PLAID_ENV', event.target.value)}
            disabled={busy}
          >
            <option value="sandbox">sandbox</option>
            <option value="production">production</option>
          </select>
        </label>

        <label>
          Plaid redirect URI
          <input
            type="url"
            placeholder="https://your-domain/"
            value={form.PLAID_REDIRECT_URI || ''}
            onChange={(event) => update('PLAID_REDIRECT_URI', event.target.value)}
            disabled={busy}
          />
        </label>

        <label>
          Google Sheet URL or ID
          <input
            type="text"
            placeholder="https://docs.google.com/spreadsheets/d/..."
            value={form.GOOGLE_SHEETS_SPREADSHEET_ID || ''}
            onChange={(event) => update('GOOGLE_SHEETS_SPREADSHEET_ID', event.target.value)}
            disabled={busy}
          />
        </label>

        <label>
          Timezone
          <select
            value={form.TZ || 'America/New_York'}
            onChange={(event) => update('TZ', event.target.value)}
            disabled={busy}
          >
            {TIMEZONES.map((zone) => (
              <option key={zone.value} value={zone.value}>
                {zone.label}
              </option>
            ))}
          </select>
        </label>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={String(form.DAILY_SYNC_ENABLED || 'true') !== 'false'}
            onChange={(event) => update('DAILY_SYNC_ENABLED', event.target.checked ? 'true' : 'false')}
            disabled={busy}
          />
          Run the daily Google Sheets update
        </label>

        <label>
          Daily sync cron
          <input
            type="text"
            value={form.DAILY_SYNC_CRON || ''}
            onChange={(event) => update('DAILY_SYNC_CRON', event.target.value)}
            disabled={busy}
          />
          <span className="field-help">Default `59 11 * * *` is 11:59 AM. `59 23 * * *` is 11:59 PM.</span>
        </label>

        <label>
          Google Drive folder ID for month PDFs
          <input
            type="text"
            value={form.GOOGLE_PDF_FOLDER_ID || ''}
            onChange={(event) => update('GOOGLE_PDF_FOLDER_ID', event.target.value)}
            disabled={busy}
          />
        </label>

        <label>
          Share month PDFs with this email
          <input
            type="email"
            value={form.GOOGLE_PDF_SHARE_EMAIL || ''}
            onChange={(event) => update('GOOGLE_PDF_SHARE_EMAIL', event.target.value)}
            disabled={busy}
          />
        </label>

        <button type="submit" disabled={busy}>
          {busy ? 'Saving...' : 'Save settings'}
        </button>
      </form>

      {message ? <p className={`message ${message.type}`}>{message.text}</p> : null}
    </section>
  );
}
