import { TotalsCell } from './Login.jsx';

function sumBanks(banks) {
  return (banks || []).reduce(
    (acc, bank) => ({
      total_money_in: acc.total_money_in + Number(bank.total_money_in || 0),
      total_money_out: acc.total_money_out + Number(bank.total_money_out || 0),
      final_balance: acc.final_balance + Number(bank.final_balance || 0),
    }),
    { total_money_in: 0, total_money_out: 0, final_balance: 0 }
  );
}

function formatConnectedAt(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function Dashboard({
  banks,
  dateLabel,
  message,
  busy,
  plaidEnv,
  sheetsConfigured,
  spreadsheetUrl,
  sheetTab,
  dailySync,
  lastSyncAt,
  lastSheetExportAt,
  onConnect,
  onSync,
  onExport,
}) {
  const list = banks || [];
  const connected = list.length > 0;
  const combined = sumBanks(list);
  const syncTime = dailySync?.time || '11:59 AM';
  const syncZone = dailySync?.timezone || 'America/New_York';

  return (
    <>
      <section className="card">
        <h1>Connect Your Bank</h1>
        <p className="subtitle">
          Connect each bank once. The app saves them and updates Google Sheets every day at 11:59 AM.
        </p>

        <button type="button" onClick={onConnect} disabled={busy}>
          Connect Bank Account
        </button>
        {connected ? (
          <>
            <button id="sync-button" type="button" onClick={onSync} disabled={busy}>
              Sync Transactions
            </button>
            <button id="sheets-button" type="button" onClick={onExport} disabled={busy}>
              Send to Google Sheets
            </button>
          </>
        ) : null}

        {message ? <p className={`message ${message.type}`}>{message.text}</p> : <p className="message" />}

        <section className={`plaid-status ${connected ? 'is-connected' : 'is-disconnected'}`}>
          <span className="status-dot" aria-hidden="true" />
          <div>
            <p className="plaid-status-title">{connected ? 'Plaid connected' : 'Plaid not connected'}</p>
            <p className="plaid-status-meta">
              {connected
                ? `${list.length} bank${list.length === 1 ? '' : 's'} linked${
                    plaidEnv ? ` · ${plaidEnv}` : ''
                  }`
                : 'Connect a bank to start syncing totals.'}
            </p>
            {connected ? (
              <p className="plaid-status-meta">
                Daily sheet update {dailySync?.enabled === false ? 'is off' : `at ${syncTime} (${syncZone})`}
              </p>
            ) : null}
            <p className="plaid-status-meta">
              Last sync: {formatConnectedAt(lastSyncAt) || 'Not synced yet'}
            </p>
          </div>
        </section>

        <section className={`plaid-status ${sheetsConfigured ? 'is-connected' : 'is-disconnected'}`}>
          <span className="status-dot" aria-hidden="true" />
          <div>
            <p className="plaid-status-title">
              {sheetsConfigured ? 'Google Sheets connected' : 'Google Sheets not connected'}
            </p>
            <p className="plaid-status-meta">
              {sheetsConfigured
                ? `Writing to ${sheetTab || 'the current month tab'}`
                : 'Add the spreadsheet ID and service account to .env.'}
            </p>
            {spreadsheetUrl ? (
              <a className="sheet-link" href={spreadsheetUrl} target="_blank" rel="noreferrer">
                Open Google Sheet
              </a>
            ) : null}
            <p className="plaid-status-meta">
              Last sent to Google Sheets: {formatConnectedAt(lastSheetExportAt) || 'Not sent yet'}
            </p>
          </div>
        </section>
      </section>

      {connected ? (
        <section className="card banks-card">
          <div className="transactions-header">
            <h2>Banks</h2>
            <p>
              {list.length} bank{list.length === 1 ? '' : 's'}
            </p>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Bank</th>
                  <th>{dateLabel || 'Date'}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((bank) => (
                  <tr key={bank.bank_name}>
                    <td>
                      <div>{bank.bank_name}</div>
                      {formatConnectedAt(bank.connected_at) ? (
                        <div className="connected-at">Linked {formatConnectedAt(bank.connected_at)}</div>
                      ) : null}
                    </td>
                    <TotalsCell bank={bank} />
                  </tr>
                ))}
                <tr className="all-banks">
                  <td>All banks</td>
                  <TotalsCell bank={combined} />
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <section className="card banks-card">
          <div className="transactions-header">
            <h2>Banks</h2>
          </div>
          <p className="empty">No banks connected yet.</p>
        </section>
      )}
    </>
  );
}
