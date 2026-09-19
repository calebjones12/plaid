const fs = require('fs');
const path = require('path');

const dataDir = path.resolve(__dirname, process.env.DATA_DIR || './data');
const itemsPath = path.join(dataDir, 'items.json');
const pdfDir = path.join(dataDir, 'pdfs');
const pdfExportsPath = path.join(dataDir, 'pdf-exports.json');
const activityPath = path.join(dataDir, 'activity.json');

function serializeItems(connectedItems) {
  return Array.from(connectedItems.values()).map((item) => ({
    item_id: item.item_id,
    access_token: item.access_token,
    institution_name: item.institution_name,
    cursor: item.cursor || null,
    connected_at: item.connected_at,
    last_totals: item.last_totals || null,
  }));
}

function saveItems(connectedItems) {
  fs.mkdirSync(dataDir, { recursive: true });
  const payload = {
    saved_at: new Date().toISOString(),
    items: serializeItems(connectedItems),
  };
  fs.writeFileSync(itemsPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
}

function loadSavedRecords() {
  if (!fs.existsSync(itemsPath)) {
    return [];
  }

  const raw = JSON.parse(fs.readFileSync(itemsPath, 'utf8'));
  return Array.isArray(raw.items) ? raw.items : [];
}

function loadPdfExports() {
  if (!fs.existsSync(pdfExportsPath)) {
    return {};
  }

  const raw = JSON.parse(fs.readFileSync(pdfExportsPath, 'utf8'));
  if (raw && typeof raw.exported === 'object' && !Array.isArray(raw.exported)) {
    return raw.exported;
  }
  if (Array.isArray(raw.exported)) {
    return Object.fromEntries(raw.exported.map((name) => [name, { tab_name: name }]));
  }
  return {};
}

function hasPdfExport(tabName) {
  return Boolean(loadPdfExports()[tabName]);
}

function markPdfExported(tabName, details = {}) {
  const exported = loadPdfExports();
  exported[tabName] = {
    tab_name: tabName,
    saved_at: new Date().toISOString(),
    ...details,
  };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    pdfExportsPath,
    JSON.stringify({ exported }, null, 2),
    { mode: 0o600 }
  );
}

function savePdfFile(tabName, buffer) {
  fs.mkdirSync(pdfDir, { recursive: true });
  const filePath = path.join(pdfDir, `${tabName}.pdf`);
  fs.writeFileSync(filePath, buffer, { mode: 0o600 });
  return filePath;
}

function loadActivity() {
  if (!fs.existsSync(activityPath)) {
    return { last_sync_at: null, last_sheet_export_at: null };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(activityPath, 'utf8'));
    return {
      last_sync_at: raw.last_sync_at || null,
      last_sheet_export_at: raw.last_sheet_export_at || null,
    };
  } catch (error) {
    return { last_sync_at: null, last_sheet_export_at: null };
  }
}

function saveActivity(patch) {
  const current = loadActivity();
  const next = {
    ...current,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(activityPath, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

function markLastSync() {
  return saveActivity({ last_sync_at: new Date().toISOString() });
}

function markLastSheetExport() {
  return saveActivity({ last_sheet_export_at: new Date().toISOString() });
}

module.exports = {
  itemsPath,
  saveItems,
  loadSavedRecords,
  hasPdfExport,
  markPdfExported,
  savePdfFile,
  loadActivity,
  markLastSync,
  markLastSheetExport,
};
