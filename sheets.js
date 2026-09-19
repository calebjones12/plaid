const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { google } = require('googleapis');
const { hasPdfExport, markPdfExported, savePdfFile } = require('./storage');

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
const DEFAULT_KEY_FILE = './google-service-account.json';
const CELL_FIELDS = 'userEnteredValue,userEnteredFormat,textFormatRuns';
const DATE_HEADER_FIELDS = 'userEnteredValue,userEnteredFormat,note';
const TOTAL_ROW_LABEL = 'All banks';

function getZonedDate(now = new Date()) {
  const timezone = process.env.SCHEDULE_TIMEZONE || process.env.TZ || 'America/New_York';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    monthIndex: Number(values.month) - 1,
    day: Number(values.day),
  };
}

function getMonthTabName(now = new Date()) {
  const zoned = getZonedDate(now);
  return `${MONTH_NAMES[zoned.monthIndex]} ${zoned.year}`;
}

function getPreviousMonthTabName(now = new Date()) {
  const zoned = getZonedDate(now);
  let monthIndex = zoned.monthIndex - 1;
  let year = zoned.year;
  if (monthIndex < 0) {
    monthIndex = 11;
    year -= 1;
  }
  return `${MONTH_NAMES[monthIndex]} ${year}`;
}

function getDateColumnLabel(now = new Date()) {
  const zoned = getZonedDate(now);
  return `${zoned.day} ${MONTH_NAMES[zoned.monthIndex]}`;
}

function getScheduleTimezone() {
  return process.env.SCHEDULE_TIMEZONE || process.env.TZ || 'America/New_York';
}

function getSyncTimeLabel(now = new Date()) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: getScheduleTimezone(),
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).format(now);
}

function getDateHeaderNote(now = new Date()) {
  return `Last sync: ${getSyncTimeLabel(now)}`;
}

function getDateHeaderKey(header) {
  return String(header || '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim();
}

function isMatchingDateHeader(header, dateLabel) {
  return getDateHeaderKey(header) === dateLabel;
}

function quoteSheetName(name) {
  return `'${String(name).replace(/'/g, "''")}'`;
}

function parseSpreadsheetId(value) {
  const trimmed = String(value || '').trim();
  const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : trimmed;
}

function getGoogleErrorFields(error) {
  const data = error?.response?.data?.error;
  if (data && typeof data === 'object') {
    return {
      error_code: data.status || String(data.code || ''),
      error_message: data.message,
    };
  }

  return {
    error_code: error.code,
    error_message: error.message,
  };
}

function getSheetsConfig() {
  const spreadsheetId = parseSpreadsheetId(process.env.GOOGLE_SHEETS_SPREADSHEET_ID);
  const keyFile = path.resolve(
    __dirname,
    process.env.GOOGLE_SERVICE_ACCOUNT_FILE || DEFAULT_KEY_FILE
  );
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  return { spreadsheetId, keyFile, json };
}

function isSheetsConfigured() {
  const { spreadsheetId, keyFile, json } = getSheetsConfig();
  if (!spreadsheetId) return false;
  if (json && String(json).trim()) return true;
  return fs.existsSync(keyFile);
}

function getSpreadsheetUrl() {
  const { spreadsheetId } = getSheetsConfig();
  if (!spreadsheetId) return null;
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}

function requireSheetsConfig() {
  const config = getSheetsConfig();

  if (!config.spreadsheetId) {
    const error = new Error(
      'Google Sheets is not configured. Set GOOGLE_SHEETS_SPREADSHEET_ID in your .env file.'
    );
    error.code = 'SHEETS_NOT_CONFIGURED';
    throw error;
  }

  if (!(config.json && String(config.json).trim()) && !fs.existsSync(config.keyFile)) {
    const error = new Error(
      `Google service account credentials are missing. Add google-service-account.json or GOOGLE_SERVICE_ACCOUNT_JSON.`
    );
    error.code = 'SHEETS_KEY_MISSING';
    throw error;
  }

  return config;
}

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
];

function createGoogleAuth() {
  const config = requireSheetsConfig();

  if (config.json && String(config.json).trim()) {
    return new google.auth.GoogleAuth({
      credentials: JSON.parse(config.json),
      scopes: GOOGLE_SCOPES,
    });
  }

  return new google.auth.GoogleAuth({
    keyFile: config.keyFile,
    scopes: GOOGLE_SCOPES,
  });
}

function createSheetsClient(auth = createGoogleAuth()) {
  return google.sheets({ version: 'v4', auth });
}

async function ensureTab(sheets, spreadsheetId, tabName) {
  const loadSpreadsheet = async () =>
    sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'spreadsheetUrl,sheets.properties(sheetId,title)',
    });

  let spreadsheet = await loadSpreadsheet();
  const titles = (spreadsheet.data.sheets || []).map((sheet) => sheet.properties?.title);
  if (!titles.includes(tabName)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title: tabName,
              },
            },
          },
        ],
      },
    });
    spreadsheet = await loadSpreadsheet();
  }

  const sheet = (spreadsheet.data.sheets || []).find(
    (entry) => entry.properties?.title === tabName
  );

  return {
    spreadsheetUrl: spreadsheet.data.spreadsheetUrl,
    sheetId: sheet?.properties?.sheetId,
  };
}

async function downloadSheetPdf(auth, spreadsheetId, gid) {
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  const accessToken = token?.token || token;
  const params = new URLSearchParams({
    format: 'pdf',
    gid: String(gid),
    portrait: 'false',
    fitw: 'true',
    size: 'letter',
    gridlines: 'true',
    sheetnames: 'true',
    printtitle: 'false',
    pagenum: 'FALSE',
    fzr: 'true',
  });
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?${params.toString()}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const contentType = String(response.headers.get('content-type') || '');
  if (!response.ok || !contentType.includes('pdf')) {
    const error = new Error(`PDF export failed (${response.status}). Enable the Google Drive API for this service account.`);
    error.code = 'PDF_EXPORT_FAILED';
    throw error;
  }

  return Buffer.from(await response.arrayBuffer());
}

async function uploadMonthPdf(drive, spreadsheetId, tabName, buffer) {
  const folderId = String(process.env.GOOGLE_PDF_FOLDER_ID || '').trim();
  let parentId = folderId || null;
  let ownerEmail = String(process.env.GOOGLE_PDF_SHARE_EMAIL || '').trim() || null;

  try {
    const meta = await drive.files.get({
      fileId: spreadsheetId,
      fields: 'parents, owners(emailAddress)',
      supportsAllDrives: true,
    });
    if (!parentId) {
      parentId = meta.data.parents?.[0] || null;
    }
    if (!ownerEmail) {
      ownerEmail = meta.data.owners?.[0]?.emailAddress || null;
    }
  } catch (error) {
    console.warn('[Google Drive] Could not read spreadsheet folder', getGoogleErrorFields(error));
  }

  const requestBody = {
    name: `${tabName}.pdf`,
    mimeType: 'application/pdf',
  };
  if (parentId) {
    requestBody.parents = [parentId];
  }

  let created;
  try {
    created = await drive.files.create({
      requestBody,
      media: {
        mimeType: 'application/pdf',
        body: Readable.from(buffer),
      },
      fields: 'id, webViewLink, name',
      supportsAllDrives: true,
    });
  } catch (error) {
    if (!parentId) throw error;
    created = await drive.files.create({
      requestBody: {
        name: `${tabName}.pdf`,
        mimeType: 'application/pdf',
      },
      media: {
        mimeType: 'application/pdf',
        body: Readable.from(buffer),
      },
      fields: 'id, webViewLink, name',
      supportsAllDrives: true,
    });
  }

  if (ownerEmail && created.data.id) {
    try {
      await drive.permissions.create({
        fileId: created.data.id,
        requestBody: {
          type: 'user',
          role: 'writer',
          emailAddress: ownerEmail,
        },
        sendNotificationEmail: false,
        supportsAllDrives: true,
      });
    } catch (error) {
      console.warn('[Google Drive] Could not share month PDF', getGoogleErrorFields(error));
    }
  }

  return created.data;
}

async function archivePreviousMonthPdf(auth, spreadsheetId, now = new Date()) {
  const tabName = getPreviousMonthTabName(now);
  if (hasPdfExport(tabName)) {
    return null;
  }

  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties(sheetId,title)',
  });
  const sheet = (spreadsheet.data.sheets || []).find(
    (entry) => entry.properties?.title === tabName
  );
  if (!sheet) {
    return null;
  }

  const buffer = await downloadSheetPdf(auth, spreadsheetId, sheet.properties.sheetId);
  const localPath = savePdfFile(tabName, buffer);

  let driveFile = null;
  try {
    const drive = google.drive({ version: 'v3', auth });
    driveFile = await uploadMonthPdf(drive, spreadsheetId, tabName, buffer);
  } catch (error) {
    console.error('[Google Drive] Month PDF saved locally but Drive upload failed', getGoogleErrorFields(error));
  }

  markPdfExported(tabName, {
    local_path: localPath,
    drive_id: driveFile?.id || null,
    drive_url: driveFile?.webViewLink || null,
  });

  console.log(
    `Saved ${tabName} PDF${driveFile?.webViewLink ? `: ${driveFile.webViewLink}` : ` at ${localPath}`}`
  );

  return {
    tab_name: tabName,
    local_path: localPath,
    drive_url: driveFile?.webViewLink || null,
  };
}

function money(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 0;
  return Number(amount.toFixed(2));
}

function formatSheetMoney(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(money(value));
}

function summarizeBank(transactions, accounts, bankName) {
  let moneyIn = 0;
  let moneyOut = 0;

  for (const transaction of transactions) {
    if (transaction.pending) continue;
    const amount = Number(transaction.amount);
    if (!Number.isFinite(amount) || amount === 0) continue;
    // Plaid: positive amount leaves the account.
    if (amount > 0) moneyOut += amount;
    else moneyIn += Math.abs(amount);
  }

  const depository = accounts.filter((account) => account.type === 'depository');
  const cashAccounts = depository.length
    ? depository
    : accounts.filter((account) => account.type !== 'credit' && account.type !== 'loan');
  const balanceAccounts = cashAccounts.length ? cashAccounts : accounts;
  const finalBalance = balanceAccounts.reduce((sum, account) => {
    return sum + (Number(account.balances?.current) || 0);
  }, 0);

  return {
    bank_name: bankName || 'Connected bank',
    total_money_in: money(moneyIn),
    total_money_out: money(moneyOut),
    final_balance: money(finalBalance),
  };
}

function isTotalsRow(name) {
  const label = String(name || '').trim().toLowerCase();
  return label === TOTAL_ROW_LABEL.toLowerCase() || label === 'total';
}

function sumBanks(banks) {
  return {
    bank_name: TOTAL_ROW_LABEL,
    total_money_in: money((banks || []).reduce((sum, bank) => sum + Number(bank.total_money_in || 0), 0)),
    total_money_out: money((banks || []).reduce((sum, bank) => sum + Number(bank.total_money_out || 0), 0)),
    final_balance: money((banks || []).reduce((sum, bank) => sum + Number(bank.final_balance || 0), 0)),
  };
}

function parseTotalsCell(text) {
  const source = String(text || '');
  const read = (label) => {
    const match = source.match(new RegExp(`${label}\\s*([^\\n]+)`, 'i'));
    const raw = String(match?.[1] || '').replace(/[^0-9.-]/g, '');
    return money(raw);
  };

  return {
    total_money_in: read('Total money in:'),
    total_money_out: read('Total money out:'),
    final_balance: read('Final balance:'),
  };
}

function combinedFromGridColumn(grid, columnIndex) {
  let moneyIn = 0;
  let moneyOut = 0;
  let balance = 0;

  for (let index = 1; index < grid.length; index += 1) {
    const name = String(grid[index]?.[0] || '').trim();
    if (!name || isTotalsRow(name)) continue;
    const parsed = parseTotalsCell(grid[index]?.[columnIndex]);
    moneyIn += parsed.total_money_in;
    moneyOut += parsed.total_money_out;
    balance += parsed.final_balance;
  }

  return {
    bank_name: TOTAL_ROW_LABEL,
    total_money_in: money(moneyIn),
    total_money_out: money(moneyOut),
    final_balance: money(balance),
  };
}

const COLOR_GREEN = { red: 0.09, green: 0.55, blue: 0.34 };
const COLOR_RED = { red: 0.72, green: 0.11, blue: 0.11 };
const COLOR_BLUE = { red: 0.15, green: 0.39, blue: 0.92 };
const COLOR_BLACK = { red: 0, green: 0, blue: 0 };

function buildTotalsRichText(bank) {
  const parts = [
    { label: 'Total money in: ', value: formatSheetMoney(bank.total_money_in), color: COLOR_GREEN },
    { label: 'Total money out: ', value: formatSheetMoney(bank.total_money_out), color: COLOR_RED, blankAfter: true },
    { label: 'Final balance: ', value: formatSheetMoney(bank.final_balance), color: COLOR_BLUE },
  ];

  let text = '';
  const textFormatRuns = [];

  parts.forEach((part, index) => {
    if (index > 0) {
      text += '\n';
    }

    textFormatRuns.push({
      startIndex: text.length,
      format: {
        bold: true,
        foregroundColor: part.color,
      },
    });
    text += part.label;

    textFormatRuns.push({
      startIndex: text.length,
      format: {
        bold: false,
        foregroundColor: COLOR_BLACK,
      },
    });
    text += part.value;

    if (part.blankAfter) {
      text += '\n';
    }
  });

  return { text, textFormatRuns };
}

function headerCell(text) {
  return {
    userEnteredValue: { stringValue: text },
    userEnteredFormat: {
      textFormat: {
        bold: true,
        foregroundColor: COLOR_BLACK,
      },
    },
  };
}

function dateHeaderCell(text, now = new Date()) {
  return {
    ...headerCell(text),
    note: getDateHeaderNote(now),
  };
}

function bankNameCell(name, options = {}) {
  return {
    userEnteredValue: { stringValue: name },
    userEnteredFormat: {
      verticalAlignment: 'TOP',
      ...(options.bold
        ? {
            textFormat: {
              bold: true,
              foregroundColor: COLOR_BLACK,
            },
          }
        : {}),
    },
  };
}

function totalsCell(bank) {
  const { text, textFormatRuns } = buildTotalsRichText(bank);
  return {
    userEnteredValue: { stringValue: text },
    userEnteredFormat: {
      wrapStrategy: 'WRAP',
      verticalAlignment: 'TOP',
    },
    textFormatRuns,
  };
}

function layoutRequests(sheetId, lastRowIndex) {
  return [
    {
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: 'COLUMNS',
          startIndex: 1,
          endIndex: 2,
        },
        properties: { pixelSize: 280 },
        fields: 'pixelSize',
      },
    },
    {
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: 'ROWS',
          startIndex: 1,
          endIndex: Math.max(lastRowIndex, 2),
        },
        properties: { pixelSize: 92 },
        fields: 'pixelSize',
      },
    },
  ];
}

async function readGrid(sheets, spreadsheetId, tabName) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${quoteSheetName(tabName)}!A1:ZZ1000`,
  });
  return response.data.values || [];
}

function findTotalsRowIndex(grid) {
  for (let index = grid.length - 1; index >= 1; index -= 1) {
    if (isTotalsRow(grid[index]?.[0])) return index;
  }
  return -1;
}

function buildBankRowMap(grid) {
  const map = new Map();
  for (let index = 1; index < grid.length; index += 1) {
    const name = String(grid[index]?.[0] || '').trim();
    if (name && !isTotalsRow(name)) {
      map.set(name, index);
    }
  }
  return map;
}

function buildDateColumnRequests({
  sheetId,
  banks,
  bankRowMap,
  nextRow,
  dateLabel,
  insertColumn,
  totalsRowIndex,
  now,
}) {
  const requests = [];
  const newBanks = banks.filter((bank) => !bankRowMap.has(bank.bank_name));

  if (insertColumn) {
    requests.push({
      insertDimension: {
        range: {
          sheetId,
          dimension: 'COLUMNS',
          startIndex: 1,
          endIndex: 2,
        },
        inheritFromBefore: false,
      },
    });
  }

  if (newBanks.length > 0 && totalsRowIndex >= 0) {
    requests.push({
      insertDimension: {
        range: {
          sheetId,
          dimension: 'ROWS',
          startIndex: totalsRowIndex,
          endIndex: totalsRowIndex + newBanks.length,
        },
        inheritFromBefore: false,
      },
    });
  }

  requests.push({
    updateCells: {
      start: { sheetId, rowIndex: 0, columnIndex: 1 },
      rows: [{ values: [dateHeaderCell(dateLabel, now)] }],
      fields: DATE_HEADER_FIELDS,
    },
  });

  let appendAt = totalsRowIndex >= 0 ? totalsRowIndex : nextRow;
  let lastRowIndex = Math.max(nextRow, 2);

  for (const bank of banks) {
    const existingRow = bankRowMap.get(bank.bank_name);
    if (existingRow == null) {
      requests.push({
        updateCells: {
          start: { sheetId, rowIndex: appendAt, columnIndex: 0 },
          rows: [{ values: [bankNameCell(bank.bank_name), totalsCell(bank)] }],
          fields: CELL_FIELDS,
        },
      });
      bankRowMap.set(bank.bank_name, appendAt);
      lastRowIndex = Math.max(lastRowIndex, appendAt + 1);
      appendAt += 1;
    } else {
      requests.push({
        updateCells: {
          start: { sheetId, rowIndex: existingRow, columnIndex: 1 },
          rows: [{ values: [totalsCell(bank)] }],
          fields: CELL_FIELDS,
        },
      });
      lastRowIndex = Math.max(lastRowIndex, existingRow + 1);
    }
  }

  requests.push(...layoutRequests(sheetId, lastRowIndex + 1));
  return requests;
}

async function writeAllBanksTotalsRow(sheets, spreadsheetId, tabName, sheetId, banks, dateLabel) {
  const grid = await readGrid(sheets, spreadsheetId, tabName);
  const headers = grid[0] || [];
  const existingTotalsRow = findTotalsRowIndex(grid);
  let lastBankRow = 0;

  for (let index = 1; index < grid.length; index += 1) {
    const name = String(grid[index]?.[0] || '').trim();
    if (name && !isTotalsRow(name)) lastBankRow = index;
  }

  const totalsRowIndex = existingTotalsRow >= 0 ? existingTotalsRow : lastBankRow + 1;
  const todayCol = headers.findIndex(
    (header, index) => index > 0 && isMatchingDateHeader(header, dateLabel)
  );
  const liveCol = todayCol >= 1 ? todayCol : 1;
  const columnCount = Math.max(headers.length, liveCol + 1);
  const values = [bankNameCell(TOTAL_ROW_LABEL, { bold: true })];

  for (let columnIndex = 1; columnIndex < columnCount; columnIndex += 1) {
    values.push(
      totalsCell(columnIndex === liveCol ? sumBanks(banks) : combinedFromGridColumn(grid, columnIndex))
    );
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          updateCells: {
            start: { sheetId, rowIndex: totalsRowIndex, columnIndex: 0 },
            rows: [{ values }],
            fields: CELL_FIELDS,
          },
        },
        ...layoutRequests(sheetId, totalsRowIndex + 1),
      ],
    },
  });
}

async function exportBanksToSheet(banks, now = new Date()) {
  const config = requireSheetsConfig();
  const auth = createGoogleAuth();
  const sheets = createSheetsClient(auth);
  const tabName = getMonthTabName(now);
  const dateLabel = getDateColumnLabel(now);
  const { spreadsheetUrl, sheetId } = await ensureTab(sheets, config.spreadsheetId, tabName);

  if (sheetId == null) {
    const error = new Error('Google Sheet tab was created, but its ID could not be read.');
    error.code = 'SHEETS_TAB_MISSING';
    throw error;
  }

  const grid = await readGrid(sheets, config.spreadsheetId, tabName);
  const isEmpty = grid.length === 0 || !String(grid[0]?.[0] || '').trim();

  if (isEmpty) {
    const rows = [
      { values: [headerCell('Bank'), dateHeaderCell(dateLabel, now)] },
      ...banks.map((bank) => ({
        values: [bankNameCell(bank.bank_name), totalsCell(bank)],
      })),
      { values: [bankNameCell(TOTAL_ROW_LABEL, { bold: true }), totalsCell(sumBanks(banks))] },
    ];

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.spreadsheetId,
      requestBody: {
        requests: [
          {
            updateCells: {
              start: { sheetId, rowIndex: 0, columnIndex: 0 },
              rows,
              fields: CELL_FIELDS,
            },
          },
          {
            updateCells: {
              start: { sheetId, rowIndex: 0, columnIndex: 1 },
              rows: [{ values: [dateHeaderCell(dateLabel, now)] }],
              fields: DATE_HEADER_FIELDS,
            },
          },
          ...layoutRequests(sheetId, rows.length),
        ],
      },
    });
  } else {
    const headers = grid[0] || [];
    const existingCol = headers.findIndex(
      (header, index) => index > 0 && isMatchingDateHeader(header, dateLabel)
    );
    const firstDateHeader = String(headers[1] || '').trim();
    const requests = [];

    if (existingCol > 1) {
      requests.push({
        moveDimension: {
          source: {
            sheetId,
            dimension: 'COLUMNS',
            startIndex: existingCol,
            endIndex: existingCol + 1,
          },
          destinationIndex: 1,
        },
      });
    }

    const insertColumn = existingCol < 1 && firstDateHeader !== 'Totals';
    requests.push(
      ...buildDateColumnRequests({
        sheetId,
        banks,
        bankRowMap: buildBankRowMap(grid),
        nextRow: Math.max(grid.length, 1),
        dateLabel,
        insertColumn,
        totalsRowIndex: findTotalsRowIndex(grid),
        now,
      })
    );

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.spreadsheetId,
      requestBody: { requests },
    });

    await writeAllBanksTotalsRow(
      sheets,
      config.spreadsheetId,
      tabName,
      sheetId,
      banks,
      dateLabel
    );
  }

  let monthPdf = null;
  try {
    monthPdf = await archivePreviousMonthPdf(auth, config.spreadsheetId, now);
  } catch (error) {
    console.error('[Google Drive] Unable to save previous month PDF', getGoogleErrorFields(error));
  }

  return {
    spreadsheet_url: spreadsheetUrl,
    tab_name: tabName,
    date_label: dateLabel,
    banks,
    month_pdf: monthPdf,
  };
}

module.exports = {
  exportBanksToSheet,
  summarizeBank,
  sumBanks,
  getMonthTabName,
  getPreviousMonthTabName,
  getDateColumnLabel,
  getGoogleErrorFields,
  isSheetsConfigured,
  getSpreadsheetUrl,
};
