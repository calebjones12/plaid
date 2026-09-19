async function parseJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error('Backend returned invalid JSON.');
  }
}

function friendlyError(data, fallback) {
  if (!data) return fallback;
  if (data.error_code && data.error_message) return `${data.error}: ${data.error_code}`;
  return data.error || data.error_message || fallback;
}

export async function requestJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      credentials: 'same-origin',
      ...options,
    });
  } catch (error) {
    throw new Error('Unable to reach the backend. Refresh and try again.');
  }

  const data = await parseJson(response);
  if (!response.ok || data.success === false) {
    const error = new Error(friendlyError(data, 'Request failed'));
    error.status = response.status;
    error.details = data;
    throw error;
  }
  return data;
}

export function postJson(url, body) {
  return requestJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : '{}',
  });
}

export function getMe() {
  return requestJson('/api/me');
}

export function login(username, password) {
  return postJson('/api/login', { username, password });
}

export function logout() {
  return postJson('/api/logout');
}

export function getStatus() {
  return requestJson('/api/status');
}

export function createLinkToken() {
  return postJson('/api/create_link_token');
}

export function exchangePublicToken(publicToken) {
  return postJson('/api/exchange_public_token', { public_token: publicToken });
}

export function syncTransactions() {
  return postJson('/api/sync_transactions');
}

export function exportToGoogleSheet() {
  return postJson('/api/export_google_sheet');
}

export function getSettings() {
  return requestJson('/api/settings');
}

export function saveSettings(settings) {
  return postJson('/api/settings', { settings });
}
