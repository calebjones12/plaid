export function formatMoney(amount) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(Number(amount) || 0);
}

export function TotalsCell({ bank }) {
  return (
    <td className="totals">
      <div>
        <span className="total-label in">Total money in:</span>
        <span className="total-value"> {formatMoney(bank.total_money_in)}</span>
      </div>
      <div>
        <span className="total-label out">Total money out:</span>
        <span className="total-value"> {formatMoney(bank.total_money_out)}</span>
      </div>
      <div className="total-break" />
      <div>
        <span className="total-label balance">Final balance:</span>
        <span className="total-value"> {formatMoney(bank.final_balance)}</span>
      </div>
    </td>
  );
}

export default function LoginForm({ onSubmit, busy, message }) {
  return (
    <section className="card login-card">
      <h1>Sign in</h1>
      <p className="subtitle">Enter your username and password to open the bank dashboard.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          onSubmit(String(form.get('username') || ''), String(form.get('password') || ''));
        }}
      >
        <label>
          Username
          <input name="username" type="text" autoComplete="username" required disabled={busy} />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            disabled={busy}
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
      {message ? <p className={`message ${message.type}`}>{message.text}</p> : null}
    </section>
  );
}
