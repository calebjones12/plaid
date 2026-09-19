const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const dataDir = path.resolve(__dirname, process.env.DATA_DIR || './data');
const settingsPath = path.join(dataDir, 'settings.json');

const ALLOWED_KEYS = [
  'PLAID_ENV',
  'PLAID_REDIRECT_URI',
  'GOOGLE_SHEETS_SPREADSHEET_ID',
  'TZ',
  'DAILY_SYNC_ENABLED',
  'DAILY_SYNC_CRON',
  'GOOGLE_PDF_FOLDER_ID',
  'GOOGLE_PDF_SHARE_EMAIL',
];

const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'UTC',
];

const defaultsFromEnv = Object.fromEntries(
  ALLOWED_KEYS.map((key) => [key, process.env[key] == null ? '' : String(process.env[key])])
);

function parseSpreadsheetId(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : trimmed;
}

function loadSavedSettings() {
  if (!fs.existsSync(settingsPath)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch (error) {
    return {};
  }
}

function applySavedSettings() {
  const saved = loadSavedSettings();
  for (const key of ALLOWED_KEYS) {
    const value = saved[key] == null || saved[key] === '' ? defaultsFromEnv[key] : String(saved[key]);
    if (value === '') {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  if (process.env.TZ) {
    process.env.SCHEDULE_TIMEZONE = process.env.TZ;
  }
}

function getPublicSettings() {
  applySavedSettings();
  return Object.fromEntries(
    ALLOWED_KEYS.map((key) => [key, process.env[key] == null ? '' : String(process.env[key])])
  );
}

function validateSettings(input) {
  const next = {};
  const source = input && typeof input === 'object' ? input : {};

  for (const key of ALLOWED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = String(source[key] == null ? '' : source[key]).trim();

    if (key === 'PLAID_ENV' && value && value !== 'sandbox' && value !== 'production') {
      throw Object.assign(new Error('PLAID_ENV must be sandbox or production.'), { code: 'INVALID_SETTING' });
    }

    if (key === 'PLAID_REDIRECT_URI' && value && !/^https?:\/\/\S+$/i.test(value)) {
      throw Object.assign(new Error('PLAID_REDIRECT_URI must be an http or https URL.'), { code: 'INVALID_SETTING' });
    }

    if (key === 'GOOGLE_SHEETS_SPREADSHEET_ID') {
      const id = parseSpreadsheetId(value);
      if (id && !/^[a-zA-Z0-9-_]+$/.test(id)) {
        throw Object.assign(new Error('Google Sheet ID looks invalid.'), { code: 'INVALID_SETTING' });
      }
      next[key] = id;
      continue;
    }

    if (key === 'TZ' && value && !TIMEZONES.includes(value)) {
      throw Object.assign(new Error('Choose a supported timezone.'), { code: 'INVALID_SETTING' });
    }

    if (key === 'DAILY_SYNC_ENABLED' && value && value !== 'true' && value !== 'false') {
      throw Object.assign(new Error('Daily sync must be true or false.'), { code: 'INVALID_SETTING' });
    }

    if (key === 'DAILY_SYNC_CRON' && value && !cron.validate(value)) {
      throw Object.assign(new Error('Daily sync schedule is not a valid cron expression.'), { code: 'INVALID_SETTING' });
    }

    if (key === 'GOOGLE_PDF_FOLDER_ID' && value && !/^[a-zA-Z0-9-_]+$/.test(value)) {
      throw Object.assign(new Error('Google Drive folder ID looks invalid.'), { code: 'INVALID_SETTING' });
    }

    if (key === 'GOOGLE_PDF_SHARE_EMAIL' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      throw Object.assign(new Error('PDF share email looks invalid.'), { code: 'INVALID_SETTING' });
    }

    next[key] = value;
  }

  return next;
}

function savePublicSettings(input) {
  const updates = validateSettings(input);
  const saved = { ...loadSavedSettings() };

  for (const key of Object.keys(updates)) {
    if (updates[key] === '') {
      delete saved[key];
    } else {
      saved[key] = updates[key];
    }
  }

  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(saved, null, 2), { mode: 0o600 });
  applySavedSettings();
  return getPublicSettings();
}

module.exports = {
  applySavedSettings,
  getPublicSettings,
  savePublicSettings,
};
