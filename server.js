require('dotenv').config();

const path = require('path');
const express = require('express');
const { applySavedSettings, getPublicSettings, savePublicSettings } = require('./settings');

applySavedSettings();
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  Products,
  CountryCode,
} = require('plaid');
const {
  exportBanksToSheet,
  summarizeBank,
  getMonthTabName,
  getDateColumnLabel,
  getGoogleErrorFields,
  isSheetsConfigured,
  getSpreadsheetUrl,
} = require('./sheets');
const { saveItems, loadSavedRecords, loadActivity, markLastSync, markLastSheetExport } = require('./storage');
const {
  requireAuth,
  requireAuthConfig,
  requireAdmin,
  isAdmin,
  readSession,
  getLock,
  registerFailure,
  clearFailures,
  setSessionCookie,
  clearSessionCookie,
  verifyLogin,
} = require('./auth');
const cron = require('node-cron');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const clientDist = path.join(__dirname, 'client', 'dist');

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://cdn.plaid.com'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https://cdn.plaid.com', 'https://*.plaid.com'],
        connectSrc: ["'self'", 'https://cdn.plaid.com', 'https://*.plaid.com'],
        frameSrc: ['https://cdn.plaid.com', 'https://*.plaid.com'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'no-referrer' },
    xFrameOptions: { action: 'deny' },
  })
);
app.use((req, res, next) => {
  res.set(
    'X-Robots-Tag',
    'noindex, nofollow, noarchive, nosnippet, noimageindex, nocache'
  );
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  next();
});
app.use(express.json({ limit: '32kb' }));
app.use(cookieParser());

app.get('/robots.txt', (_req, res) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  res.send('User-agent: *\nDisallow: /\n');
});

app.get('/sitemap.xml', (_req, res) => {
  res.status(404).type('text/plain').send('Not found');
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many sign-in attempts. Try again later.' },
});

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.use('/api', (req, res, next) => {
  if (req.path === '/login' && req.method === 'POST') return next();
  if (req.path === '/logout' && req.method === 'POST') return next();
  if (req.path === '/me' && req.method === 'GET') return next();
  if (req.path === '/daily_sync' && req.method === 'POST') return next();
  return requireAuth(req, res, next);
});

app.get('/api/me', (req, res) => {
  const session = readSession(req);
  return res.json({
    success: true,
    authenticated: Boolean(session),
    username: session?.username || null,
    is_admin: Boolean(session) && isAdmin(),
  });
});

app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    requireAuthConfig();
  } catch (error) {
    return sendError(res, 500, error.message, error);
  }

  const lock = getLock(req);
  if (lock?.lockedUntil && lock.lockedUntil > Date.now()) {
    return sendError(res, 429, 'Too many failed sign-in attempts. Try again in 15 minutes.');
  }

  const username = String(req.body?.username || '');
  const password = String(req.body?.password || '');
  const ok = await verifyLogin(username, password);
  if (!ok) {
    registerFailure(req);
    return sendError(res, 401, 'Invalid username or password.');
  }

  clearFailures(req);
  const sessionUser = String(process.env.ADMIN_USERNAME || '').trim();
  setSessionCookie(req, res, sessionUser);
  return res.json({ success: true, username: sessionUser, is_admin: isAdmin() });
});

app.post('/api/logout', (req, res) => {
  clearSessionCookie(req, res);
  return res.json({ success: true });
});

app.get('/api/settings', requireAdmin, (req, res) => {
  return res.json({
    success: true,
    settings: getPublicSettings(),
  });
});

app.post('/api/settings', requireAdmin, (req, res) => {
  try {
    const settings = savePublicSettings(req.body?.settings || req.body || {});
    startDailySchedule();
    return res.json({
      success: true,
      settings,
      spreadsheet_url: getSpreadsheetUrl(),
      sheet_tab: getMonthTabName(),
    });
  } catch (error) {
    const status = error.code === 'INVALID_SETTING' ? 400 : 500;
    return sendError(res, status, error.message, error);
  }
});

/*
  Token roles in this app:

  link_token
  Temporary token used to initialize Plaid Link. Created on the server and
  sent to the browser. It is not a secret like PLAID_SECRET.

  public_token
  Temporary token returned after successful Plaid Link authentication.
  The browser sends it to this server once, then it is exchanged.

  access_token
  Long-lived server-side credential used to call Plaid APIs for the
  connected Item. NEVER send this to the browser.

  item_id
  Plaid identifier for the connected institution login.

  Security model:
  Browser: public_token ✓   access_token ✗   PLAID_SECRET ✗
  Server:  public_token ✓   access_token ✓   PLAID_SECRET ✓
*/

/*
  Connected Plaid Items are kept in memory and also saved to data/items.json
  so daily jobs still work after a restart. Never send access_token to the browser.
*/
const connectedItems = new Map();

function createEmptyItem(accessToken, itemId, institutionName) {
  return {
    access_token: accessToken,
    item_id: itemId,
    institution_name: institutionName || 'Connected bank',
    connected_at: new Date().toISOString(),
    cursor: null,
    accounts: [],
    transactions: new Map(),
    last_totals: null,
  };
}

function persistItems() {
  saveItems(connectedItems);
}

function restoreItems() {
  const saved = loadSavedRecords();
  for (const record of saved) {
    if (!record.access_token || !record.item_id) continue;
    const item = createEmptyItem(
      record.access_token,
      record.item_id,
      record.institution_name
    );
    item.cursor = record.cursor || null;
    item.connected_at = record.connected_at || item.connected_at;
    item.last_totals = record.last_totals || null;
    connectedItems.set(item.item_id, item);
  }
  if (connectedItems.size > 0) {
    console.log(`Restored ${connectedItems.size} connected bank${connectedItems.size === 1 ? '' : 's'} from disk`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requirePlaidCredentials() {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;

  if (!clientId || !secret) {
    const error = new Error(
      'Plaid credentials are missing. Set PLAID_CLIENT_ID and PLAID_SECRET in your .env file.'
    );
    error.code = 'MISSING_CREDENTIALS';
    throw error;
  }

  return { clientId, secret };
}

function getPlaidEnvironmentName() {
  const env = (process.env.PLAID_ENV || 'production').toLowerCase().trim();

  // Plaid retired the Development environment on June 20, 2024.
  // The current Node SDK only exposes sandbox and production.
  if (env === 'development') {
    const error = new Error(
      'Plaid retired the Development environment in June 2024. Set PLAID_ENV to sandbox or production.'
    );
    error.code = 'UNSUPPORTED_PLAID_ENV';
    throw error;
  }

  if (!PlaidEnvironments[env]) {
    const error = new Error(
      `Unsupported PLAID_ENV "${process.env.PLAID_ENV}". Use sandbox or production.`
    );
    error.code = 'UNSUPPORTED_PLAID_ENV';
    throw error;
  }

  return env;
}

function createPlaidClient() {
  const { clientId, secret } = requirePlaidCredentials();
  const env = getPlaidEnvironmentName();

  const configuration = new Configuration({
    basePath: PlaidEnvironments[env],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': clientId,
        'PLAID-SECRET': secret,
        'Plaid-Version': '2020-09-14',
      },
    },
  });

  return new PlaidApi(configuration);
}

function getPlaidErrorFields(error) {
  const data = error?.response?.data;

  if (data && typeof data === 'object') {
    return {
      error_type: data.error_type,
      error_code: data.error_code,
      error_message: data.error_message,
      display_message: data.display_message,
      request_id: data.request_id,
    };
  }

  return {
    error_message: error.message,
    error_code: error.code,
  };
}

function logPlaidError(context, error) {
  console.error(`[Plaid] ${context}`, getPlaidErrorFields(error));
}

function sendError(res, status, message, error) {
  const payload = {
    success: false,
    error: message,
  };

  if (error) {
    const plaidFields = getPlaidErrorFields(error);
    const googleFields = getGoogleErrorFields(error);
    if (plaidFields.error_code) payload.error_code = plaidFields.error_code;
    if (plaidFields.error_type) payload.error_type = plaidFields.error_type;
    if (plaidFields.error_message) payload.error_message = plaidFields.error_message;
    if (plaidFields.request_id) payload.request_id = plaidFields.request_id;
    if (!payload.error_message && googleFields.error_message) {
      payload.error_code = googleFields.error_code;
      payload.error_message = googleFields.error_message;
    }
  }

  return res.status(status).json(payload);
}

app.post('/api/create_link_token', async (req, res) => {
  try {
    const client = createPlaidClient();

    // client_user_id tells Plaid which end user this Link session belongs to.
    // client-001 is fine for this single-user local test.
    // In a production multi-user system this MUST be your app's internal user ID.
    const request = {
      user: {
        client_user_id: 'client-001',
      },
      client_name: 'Plaid Finance Dashboard',
      language: 'en',
      country_codes: [CountryCode.Us],
      products: [Products.Transactions],
    };

    if (process.env.PLAID_REDIRECT_URI) {
      request.redirect_uri = process.env.PLAID_REDIRECT_URI;
    }

    const createTokenResponse = await client.linkTokenCreate(request);

    console.log('Plaid link token created');

    return res.json({
      link_token: createTokenResponse.data.link_token,
    });
  } catch (error) {
    logPlaidError('Unable to create link token', error);

    if (error.code === 'MISSING_CREDENTIALS' || error.code === 'UNSUPPORTED_PLAID_ENV') {
      return sendError(res, 500, error.message, error);
    }

    return sendError(res, 500, 'Unable to create Plaid Link token', error);
  }
});

app.post('/api/exchange_public_token', async (req, res) => {
  try {
    const publicToken = req.body?.public_token;

    if (!publicToken || typeof publicToken !== 'string') {
      return sendError(res, 400, 'public_token is missing');
    }

    const client = createPlaidClient();
    const exchangeResponse = await client.itemPublicTokenExchange({
      public_token: publicToken,
    });

    const accessToken = exchangeResponse.data.access_token;
    const itemId = exchangeResponse.data.item_id;
    const institutionName = await getInstitutionName(client, accessToken);
    const item = createEmptyItem(accessToken, itemId, institutionName);
    connectedItems.set(itemId, item);
    persistItems();

    console.log(`Plaid Item connected: ${itemId} (${institutionName})`);
    console.log('Access token stored on the server only (not printed, not sent to the browser).');

    return res.json({
      success: true,
      item_id: itemId,
      institution_name: institutionName,
      banks: listPublicBanks(),
    });
  } catch (error) {
    logPlaidError('Unable to exchange public token', error);

    if (error.code === 'MISSING_CREDENTIALS' || error.code === 'UNSUPPORTED_PLAID_ENV') {
      return sendError(res, 500, error.message, error);
    }

    return sendError(res, 500, 'Unable to exchange Plaid public token', error);
  }
});

async function getInstitutionName(client, accessToken) {
  try {
    const itemResponse = await client.itemGet({ access_token: accessToken });
    const institutionId = itemResponse.data.item?.institution_id;
    if (!institutionId) return 'Connected bank';

    const institutionResponse = await client.institutionsGetById({
      institution_id: institutionId,
      country_codes: [CountryCode.Us],
    });

    return institutionResponse.data.institution?.name || 'Connected bank';
  } catch (error) {
    logPlaidError('Unable to load institution name', error);
    return 'Connected bank';
  }
}

function requireConnectedItems() {
  if (connectedItems.size === 0) {
    const error = new Error('No bank is connected yet. Connect a bank first.');
    error.code = 'ITEM_NOT_CONNECTED';
    throw error;
  }

  return Array.from(connectedItems.values());
}

function toPublicBank(item) {
  const connection = {
    connected: true,
    connected_at: item.connected_at || null,
  };

  if (item.transactions.size === 0 && item.last_totals) {
    return {
      bank_name: item.institution_name || 'Connected bank',
      ...item.last_totals,
      ...connection,
    };
  }

  const summary = summarizeBank(
    toPublicTransactions(item),
    item.accounts || [],
    item.institution_name
  );
  item.last_totals = {
    total_money_in: summary.total_money_in,
    total_money_out: summary.total_money_out,
    final_balance: summary.final_balance,
  };
  return {
    ...summary,
    ...connection,
  };
}

function listPublicBanks() {
  return requireConnectedItems()
    .map(toPublicBank)
    .sort((left, right) => left.bank_name.localeCompare(right.bank_name));
}

async function syncTransactionPages(client, accessToken, startingCursor) {
  let cursor = startingCursor || undefined;
  const originalCursor = cursor;
  const added = [];
  const modified = [];
  const removed = [];
  let hasMore = true;

  try {
    while (hasMore) {
      const response = await client.transactionsSync({
        access_token: accessToken,
        cursor,
      });
      const data = response.data;

      added.push(...data.added);
      modified.push(...data.modified);
      removed.push(...data.removed);
      hasMore = data.has_more;
      cursor = data.next_cursor;
    }
  } catch (error) {
    const fields = getPlaidErrorFields(error);
    if (fields.error_code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION') {
      return syncTransactionPages(client, accessToken, originalCursor);
    }
    throw error;
  }

  return { added, modified, removed, cursor };
}

function applyTransactionUpdates(item, updates) {
  for (const transaction of updates.added.concat(updates.modified)) {
    item.transactions.set(transaction.transaction_id, transaction);
  }

  for (const removed of updates.removed) {
    item.transactions.delete(removed.transaction_id);
  }

  // An empty cursor means Plaid has not finished preparing data yet.
  // Keep the previous cursor so the next sync can retry cleanly.
  if (updates.cursor) {
    item.cursor = updates.cursor;
  }
}

function getAccountName(accounts, accountId) {
  const account = accounts.find((entry) => entry.account_id === accountId);
  if (!account) return 'Account';
  if (account.mask) return `${account.name} ••${account.mask}`;
  return account.name;
}

function toPublicTransactions(item) {
  return Array.from(item.transactions.values())
    .map((transaction) => ({
      transaction_id: transaction.transaction_id,
      date: transaction.date,
      name: transaction.merchant_name || transaction.name,
      amount: transaction.amount,
      iso_currency_code: transaction.iso_currency_code || 'USD',
      pending: Boolean(transaction.pending),
      category:
        transaction.personal_finance_category?.primary ||
        transaction.personal_finance_category?.detailed ||
        'OTHER',
      account: getAccountName(item.accounts, transaction.account_id),
    }))
    .sort((left, right) => {
      if (left.date === right.date) return left.name.localeCompare(right.name);
      return right.date.localeCompare(left.date);
    });
}

async function syncItem(client, item) {
  try {
    const accountsResponse = await client.accountsGet({
      access_token: item.access_token,
    });
    item.accounts = accountsResponse.data.accounts || [];
  } catch (error) {
    logPlaidError(`Unable to load accounts for ${item.institution_name}`, error);
  }

  if (!item.institution_name || item.institution_name === 'Connected bank') {
    item.institution_name = await getInstitutionName(client, item.access_token);
  }

  const maxAttempts = 5;
  let updates = { added: [], modified: [], removed: [], cursor: item.cursor };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    updates = await syncTransactionPages(client, item.access_token, item.cursor);
    applyTransactionUpdates(item, updates);

    if (item.transactions.size > 0 || updates.cursor) {
      break;
    }

    if (attempt < maxAttempts) {
      console.log(
        `Plaid transactions not ready yet for ${item.institution_name}. Retry ${attempt}/${maxAttempts - 1}...`
      );
      await sleep(1500);
    }
  }

  return updates;
}

function requireDailySecret(req) {
  const secret = process.env.DAILY_SYNC_SECRET;
  if (!secret) return;

  const header = req.get('x-sync-secret') || '';
  const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (header !== secret && bearer !== secret) {
    const error = new Error('Unauthorized daily sync request');
    error.code = 'UNAUTHORIZED';
    throw error;
  }
}

async function runDailyUpdate() {
  const items = requireConnectedItems();
  const client = createPlaidClient();

  for (const item of items) {
    await syncItem(client, item);
    console.log(
      `Plaid transactions synced for ${item.institution_name}: ${item.transactions.size} visible`
    );
  }

  const banks = listPublicBanks();
  persistItems();
  const result = await exportBanksToSheet(banks);
  persistItems();
  markLastSync();
  const activity = markLastSheetExport();

  console.log(
    `Google Sheet updated: ${result.tab_name} / ${result.date_label} (${banks.length} bank${
      banks.length === 1 ? '' : 's'
    })`
  );
  if (result.month_pdf) {
    console.log(
      `Archived ${result.month_pdf.tab_name} PDF${
        result.month_pdf.drive_url ? `: ${result.month_pdf.drive_url}` : ` at ${result.month_pdf.local_path}`
      }`
    );
  }

  return {
    ...result,
    last_sync_at: activity.last_sync_at,
    last_sheet_export_at: activity.last_sheet_export_at,
  };
}

let dailyTask = null;

function startDailySchedule() {
  if (dailyTask) {
    dailyTask.stop();
    dailyTask = null;
  }

  const enabled = String(process.env.DAILY_SYNC_ENABLED || 'true').toLowerCase() !== 'false';
  if (!enabled) {
    console.log('Daily Google Sheets sync is disabled');
    return;
  }

  const expression = process.env.DAILY_SYNC_CRON || '59 11 * * *';
  const timezone = process.env.SCHEDULE_TIMEZONE || process.env.TZ || 'America/New_York';

  if (!cron.validate(expression)) {
    console.warn(`Invalid DAILY_SYNC_CRON "${expression}"`);
    return;
  }

  dailyTask = cron.schedule(
    expression,
    () => {
      console.log(`Daily sync started (${timezone})`);
      runDailyUpdate().catch((error) => {
        console.error('[Daily sync] failed', error.message || error);
      });
    },
    { timezone }
  );

  console.log(`Daily sync scheduled at 11:59 AM (${expression}, ${timezone})`);
}

app.get('/api/status', (req, res) => {
  const sheetsConfigured = isSheetsConfigured();
  const connected = connectedItems.size > 0;
  let plaidEnv = null;
  try {
    plaidEnv = getPlaidEnvironmentName();
  } catch (error) {
    plaidEnv = null;
  }

  return res.json({
    success: true,
    connected,
    bank_count: connectedItems.size,
    banks: connected ? listPublicBanks() : [],
    plaid_env: plaidEnv,
    sheets_configured: sheetsConfigured,
    spreadsheet_url: getSpreadsheetUrl(),
    sheet_tab: getMonthTabName(),
    date_label: getDateColumnLabel(),
    ...loadActivity(),
    daily_sync: {
      enabled: String(process.env.DAILY_SYNC_ENABLED || 'true').toLowerCase() !== 'false',
      time: '11:59 AM',
      timezone: process.env.SCHEDULE_TIMEZONE || process.env.TZ || 'America/New_York',
    },
  });
});

app.get('/api/transactions', (req, res) => {
  try {
    return res.json({
      success: true,
      banks: listPublicBanks(),
    });
  } catch (error) {
    return sendError(res, 400, error.message, error);
  }
});

app.post('/api/sync_transactions', async (req, res) => {
  try {
    const items = requireConnectedItems();
    const client = createPlaidClient();

    for (const item of items) {
      await syncItem(client, item);
      console.log(
        `Plaid transactions synced for ${item.institution_name}: ${item.transactions.size} visible`
      );
    }

    persistItems();
    const banks = listPublicBanks();
    persistItems();
    const activity = markLastSync();
    return res.json({
      success: true,
      banks,
      last_sync_at: activity.last_sync_at,
    });
  } catch (error) {
    logPlaidError('Unable to sync transactions', error);

    if (error.code === 'ITEM_NOT_CONNECTED') {
      return sendError(res, 400, error.message, error);
    }

    if (error.code === 'MISSING_CREDENTIALS' || error.code === 'UNSUPPORTED_PLAID_ENV') {
      return sendError(res, 500, error.message, error);
    }

    const fields = getPlaidErrorFields(error);
    if (fields.error_code === 'PRODUCT_NOT_READY') {
      return sendError(
        res,
        503,
        'Transactions are still being prepared by Plaid. Try Sync Transactions again in a few seconds.',
        error
      );
    }

    return sendError(res, 500, 'Unable to sync Plaid transactions', error);
  }
});

app.post('/api/export_google_sheet', async (req, res) => {
  try {
    const items = requireConnectedItems();
    const client = createPlaidClient();

    for (const item of items) {
      try {
        const accountsResponse = await client.accountsGet({
          access_token: item.access_token,
        });
        item.accounts = accountsResponse.data.accounts || [];
      } catch (error) {
        logPlaidError(`Unable to refresh balances for ${item.institution_name}`, error);
      }

      if (!item.institution_name || item.institution_name === 'Connected bank') {
        item.institution_name = await getInstitutionName(client, item.access_token);
      }
    }

    persistItems();
    const banks = listPublicBanks();
    persistItems();
    const result = await exportBanksToSheet(banks);

    const activity = markLastSheetExport();

    console.log(
      `Google Sheet updated: ${result.tab_name} / ${result.date_label} (${banks.length} bank${
        banks.length === 1 ? '' : 's'
      })`
    );
    if (result.month_pdf) {
      console.log(
        `Archived ${result.month_pdf.tab_name} PDF${
          result.month_pdf.drive_url ? `: ${result.month_pdf.drive_url}` : ` at ${result.month_pdf.local_path}`
        }`
      );
    }

    return res.json({
      success: true,
      tab_name: result.tab_name,
      date_label: result.date_label,
      spreadsheet_url: result.spreadsheet_url,
      banks: result.banks,
      month_pdf: result.month_pdf,
      last_sheet_export_at: activity.last_sheet_export_at,
    });
  } catch (error) {
    const googleFields = getGoogleErrorFields(error);
    console.error('[Google Sheets] Unable to export transactions', googleFields);

    if (error.code === 'ITEM_NOT_CONNECTED') {
      return sendError(res, 400, error.message, error);
    }

    if (error.code === 'SHEETS_NOT_CONFIGURED' || error.code === 'SHEETS_KEY_MISSING') {
      return sendError(res, 400, error.message, error);
    }

    if (googleFields.error_code === 'PERMISSION_DENIED' || error.code === 403) {
      return sendError(
        res,
        403,
        'Google denied access. Share the spreadsheet with the service account email as Editor.',
        error
      );
    }

    if (googleFields.error_code === 'NOT_FOUND' || error.code === 404) {
      return sendError(
        res,
        404,
        'Google Sheet was not found. Check GOOGLE_SHEETS_SPREADSHEET_ID.',
        error
      );
    }

    return sendError(res, 500, 'Unable to export transactions to Google Sheets', error);
  }
});

app.post('/api/daily_sync', async (req, res) => {
  try {
    if (process.env.DAILY_SYNC_SECRET) {
      requireDailySecret(req);
    } else if (!readSession(req)) {
      return sendError(res, 401, 'Please sign in.');
    }
    const result = await runDailyUpdate();
    return res.json({
      success: true,
      tab_name: result.tab_name,
      date_label: result.date_label,
      spreadsheet_url: result.spreadsheet_url,
      banks: result.banks,
      month_pdf: result.month_pdf,
      last_sync_at: result.last_sync_at,
      last_sheet_export_at: result.last_sheet_export_at,
    });
  } catch (error) {
    if (error.code === 'UNAUTHORIZED') {
      return sendError(res, 401, error.message, error);
    }
    if (error.code === 'ITEM_NOT_CONNECTED') {
      return sendError(res, 400, error.message, error);
    }
    logPlaidError('Daily sync failed', error);
    return sendError(res, 500, 'Daily sync failed', error);
  }
});

restoreItems();

app.use(express.static(clientDist, { index: false }));
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path.startsWith('/api') || req.path === '/health' || req.path === '/robots.txt' || req.path === '/sitemap.xml') {
    return next();
  }
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(clientDist, 'index.html'), (error) => {
    if (error) next(error);
  });
});

const runDailyOnce =
  process.argv.includes('--daily') || process.env.RUN_DAILY_ONCE === 'true';

if (runDailyOnce) {
  runDailyUpdate()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Daily sync failed', error.message || error);
      process.exit(1);
    });
} else {
  try {
    requireAuthConfig();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  app.listen(PORT, HOST, () => {
    console.log(`Server running on http://${HOST}:${PORT}`);

    try {
      const env = getPlaidEnvironmentName();
      console.log(`Plaid environment: ${env}`);
      requireAuthConfig();
      console.log('Login is enabled');
      requirePlaidCredentials();
      console.log('Plaid credentials loaded from .env');
      if (isSheetsConfigured()) {
        console.log('Google Sheets export is configured');
      } else {
        console.warn(
          'Google Sheets export is not configured yet. Add GOOGLE_SHEETS_SPREADSHEET_ID and google-service-account.json.'
        );
      }
      startDailySchedule();
    } catch (error) {
      console.warn(error.message);
    }
  });
}
