import { useState } from "react";
import { login } from "../useAuth";
import { authErrorMessage } from "../authErrors";

export function Login() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleLogin() {
    setBusy(true);
    setError(null);
    try {
      await login();
    } catch (e) {
      setError(authErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="login-card">
        <h1>🧾 Receipt Vault</h1>
        <p className="muted">経費レシートの検索・一覧・集計</p>
        <button className="primary" onClick={handleLogin} disabled={busy}>
          {busy ? "サインイン中…" : error ? "もう一度ログイン" : "Google でサインイン"}
        </button>
        {error && <p className="error">{error}</p>}
        <p className="muted small">許可されたアカウントのみ閲覧できます。</p>
      </div>
    </div>
  );
}
