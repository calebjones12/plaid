import { useCallback, useEffect, useState } from 'react';
import LoginForm from './Login.jsx';
import Dashboard from './Dashboard.jsx';
import Settings from './Settings.jsx';
import {
  createLinkToken,
  exchangePublicToken,
  exportToGoogleSheet,
  getMe,
  getStatus,
  login,
  logout,
  syncTransactions,
} from './api.js';

function createPlaidHandler({
  linkToken,
  receivedRedirectUri,
  setBusy,
  setMessage,
  setBanks,
  setConnectedCount,
  setLastSyncAt,
}) {
  return window.Plaid.create({
    token: linkToken,
    receivedRedirectUri,
    onSuccess: async (publicToken, metadata) => {
      setBusy(true);
      setMessage({ type: 'info', text: 'Finishing secure connection...' });
      try {
        const result = await exchangePublicToken(publicToken);
        setBanks(result.banks || []);
        setConnectedCount(result.banks?.length || 0);
        const synced = await syncTransactions();
        setBanks(synced.banks || []);
        if (setLastSyncAt) setLastSyncAt(synced.last_sync_at || new Date().toISOString());
        setMessage({ type: 'success', text: 'Bank totals updated.' });
      } catch (error) {
        setMessage({ type: 'error', text: error.message });
      } finally {
        sessionStorage.removeItem('plaid_link_token');
        setBusy(false);
      }
    },
    onExit: (error, metadata) => {
      sessionStorage.removeItem('plaid_link_token');
      setBusy(false);
      if (error) {
        setMessage({
          type: 'error',
          text: error.display_message || error.error_message || 'Bank authentication failed.',
        });
        return;
      }
      const status = metadata?.status;
      if (status === 'requires_credentials' || status === 'institution_not_found') {
        setMessage({ type: 'info', text: 'Bank connection was not completed.' });
      } else {
        setMessage({ type: 'info', text: 'Plaid Link was closed before the bank was connected.' });
      }
    },
  });
}

export default function App() {
  const [auth, setAuth] = useState(null);
  const [banks, setBanks] = useState([]);
  const [dateLabel, setDateLabel] = useState('Date');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [connectedCount, setConnectedCount] = useState(0);
  const [plaidEnv, setPlaidEnv] = useState(null);
  const [sheetsConfigured, setSheetsConfigured] = useState(false);
  const [spreadsheetUrl, setSpreadsheetUrl] = useState(null);
  const [sheetTab, setSheetTab] = useState(null);
  const [dailySync, setDailySync] = useState(null);
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [lastSheetExportAt, setLastSheetExportAt] = useState(null);
  const [page, setPage] = useState('dashboard');

  const restoreDashboard = useCallback(async () => {
    const status = await getStatus();
    setDateLabel(status.date_label || 'Date');
    setBanks(status.banks || []);
    setConnectedCount(status.banks?.length || 0);
    setPlaidEnv(status.plaid_env || null);
    setSheetsConfigured(Boolean(status.sheets_configured));
    setSpreadsheetUrl(status.spreadsheet_url || null);
    setSheetTab(status.sheet_tab || null);
    setDailySync(status.daily_sync || null);
    setLastSyncAt((prev) => status.last_sync_at || prev || null);
    setLastSheetExportAt((prev) => status.last_sheet_export_at || prev || null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await getMe();
        if (cancelled) return;
        if (!me.authenticated) {
          setAuth(false);
          return;
        }
        setAuth({ username: me.username, isAdmin: me.is_admin === true });
        if (me.is_admin !== true) setPage('dashboard');
        const url = new URL(window.location.href);
        if (url.searchParams.has('oauth_state_id')) {
          const linkToken = sessionStorage.getItem('plaid_link_token');
          if (!linkToken) {
            setMessage({
              type: 'error',
              text: 'OAuth redirect is missing the saved link_token. Please connect again.',
            });
            await restoreDashboard();
            return;
          }
          if (!window.Plaid) {
            setMessage({ type: 'error', text: 'Plaid Link failed to load.' });
            return;
          }
          setBusy(true);
          setMessage({ type: 'info', text: 'Returning from your bank...' });
          const handler = createPlaidHandler({
            linkToken,
            receivedRedirectUri: window.location.href,
            setBusy,
            setMessage,
            setBanks,
            setConnectedCount,
            setLastSyncAt,
          });
          handler.open();
          return;
        }
        await restoreDashboard();
      } catch (error) {
        if (!cancelled) setAuth(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [restoreDashboard]);

  async function handleLogin(username, password) {
    setBusy(true);
    setMessage(null);
    try {
      const result = await login(username, password);
      setAuth({ username: result.username, isAdmin: result.is_admin === true });
      await restoreDashboard();
      setMessage(null);
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
      setAuth(false);
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    setBusy(true);
    try {
      await logout();
    } finally {
      setAuth(false);
      setBanks([]);
      setMessage(null);
      setPage('dashboard');
      setBusy(false);
    }
  }

  async function handleConnect() {
    setBusy(true);
    setMessage({ type: 'info', text: 'Preparing secure bank connection...' });
    try {
      if (!window.Plaid) throw new Error('Plaid Link failed to load.');
      const data = await createLinkToken();
      if (!data.link_token) throw new Error('Backend did not return a link_token.');
      sessionStorage.setItem('plaid_link_token', data.link_token);
      const handler = createPlaidHandler({
        linkToken: data.link_token,
        setBusy,
        setMessage,
        setBanks,
        setConnectedCount,
        setLastSyncAt,
      });
      handler.open();
      setMessage(null);
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
      setBusy(false);
    }
  }

  async function handleSync() {
    setBusy(true);
    setMessage({ type: 'info', text: 'Syncing transactions...' });
    try {
      const result = await syncTransactions();
      setBanks(result.banks || []);
      setConnectedCount(result.banks?.length || 0);
      setLastSyncAt(result.last_sync_at || new Date().toISOString());
      try {
        await restoreDashboard();
      } catch {
        // Keep the timestamp from this sync if status refresh fails.
      }
      setMessage({
        type: result.banks?.length ? 'success' : 'info',
        text: result.banks?.length ? 'Bank totals updated.' : 'Connect a bank first, then sync again.',
      });
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setBusy(false);
    }
  }

  async function handleExport() {
    setBusy(true);
    setMessage({ type: 'info', text: 'Sending bank totals to Google Sheets...' });
    try {
      const result = await exportToGoogleSheet();
      setDateLabel(result.date_label || dateLabel);
      setBanks(result.banks || []);
      if (result.spreadsheet_url) setSpreadsheetUrl(result.spreadsheet_url);
      setLastSheetExportAt(result.last_sheet_export_at || new Date().toISOString());
      try {
        await restoreDashboard();
      } catch {
        // Keep the timestamp from this send if status refresh fails.
      }
      const count = result.banks?.length || 0;
      setMessage({
        type: 'success',
        text: `Sent ${count} bank${count === 1 ? '' : 's'} to "${result.tab_name}" under ${result.date_label}.`,
      });
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setBusy(false);
    }
  }

  if (auth === null) {
    return (
      <main className="page">
        <section className="card">
          <p className="subtitle">Loading...</p>
        </section>
      </main>
    );
  }

  return (
    <main className="page">
      {auth ? (
        <>
          <nav className="nav">
            <div className="nav-links">
              <button
                type="button"
                className={page === 'dashboard' ? 'nav-link active' : 'nav-link'}
                onClick={() => setPage('dashboard')}
              >
                Dashboard
              </button>
              {auth.isAdmin ? (
                <button
                  type="button"
                  className={page === 'settings' ? 'nav-link active' : 'nav-link'}
                  onClick={() => setPage('settings')}
                >
                  Settings
                </button>
              ) : null}
            </div>
            <div className="nav-right">
              <p className="signed-in">Signed in as {auth.username}</p>
              <button className="logout-button" type="button" onClick={handleLogout} disabled={busy}>
                Log out
              </button>
            </div>
          </nav>
          {page === 'settings' && auth.isAdmin ? (
            <Settings
              onSaved={async (result) => {
                setSpreadsheetUrl(result.spreadsheet_url || spreadsheetUrl);
                setSheetTab(result.sheet_tab || sheetTab);
                await restoreDashboard();
              }}
            />
          ) : (
            <Dashboard
              banks={banks}
              dateLabel={dateLabel}
              message={message}
              busy={busy}
              connectedCount={connectedCount}
              plaidEnv={plaidEnv}
              sheetsConfigured={sheetsConfigured}
              spreadsheetUrl={spreadsheetUrl}
              sheetTab={sheetTab}
              dailySync={dailySync}
              lastSyncAt={lastSyncAt}
              lastSheetExportAt={lastSheetExportAt}
              onConnect={handleConnect}
              onSync={handleSync}
              onExport={handleExport}
            />
          )}
        </>
      ) : (
        <LoginForm onSubmit={handleLogin} busy={busy} message={message} />
      )}
    </main>
  );
}
