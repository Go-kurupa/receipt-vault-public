import { useEffect, useState } from "react";
import { decideOauth, errorMessage, getOauthRequest, readRequestParam, type OauthRequestInfo } from "../aiConnections";

/** ログイン連携の許可画面（/connect?request=）。本人ログイン後にだけ表示される。 */
export function Connect() {
  const [requestId] = useState(() => readRequestParam(location.search));
  const [info, setInfo] = useState<OauthRequestInfo | null>(null);
  const [error, setError] = useState<string | null>(requestId ? null : "接続の要求が見つかりません。AI 側で接続をやり直してください");
  const [organize, setOrganize] = useState(false);
  const [busy, setBusy] = useState(false);

  async function load() {
    if (!requestId) return;
    setError(null);
    try {
      setInfo(await getOauthRequest(requestId));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function decide(approve: boolean) {
    if (!requestId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { redirectUrl } = await decideOauth(requestId, approve, approve && organize);
      // 戻り先はサーバーで許可リスト・CIMD 文書と照合済みの URL だけ。
      location.assign(redirectUrl);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="login-card connect-card">
        <h1>🔐 AI からの接続の許可</h1>
        {error && <p className="error" role="alert">{error}</p>}
        {info && (
          <>
            <p>
              <strong>{info.vendor}</strong>（名乗り: {info.clientName}）が、領収書保管庫へのアクセスを求めています。
            </p>
            <p className="muted small">許可後の戻り先: {info.redirectHost}</p>
            <p className="warning">
              ⚠️ <strong>自分で AI に接続を追加した直後のときだけ</strong>許可してください。
              届いたリンクを開いただけでこの画面が出た場合は「拒否」を押してください。
            </p>
            {!info.acceptOpen && (
              <p className="error">
                新しい接続の受付が閉じています。アプリの「🤖 AI 接続」タブで「新しい接続を受け付ける」を押してから、この画面を再読み込みしてください。
              </p>
            )}
            <label className="ai-check">
              <input type="checkbox" checked={organize} onChange={(e) => setOrganize(e.target.checked)} />
              整理（科目・状態などの書き込み）も許可する
            </label>
            <p className="muted small">チェックしない場合は「読む」（検索・集計）だけです。</p>
            <div className="ai-key-actions">
              <button type="button" className="primary" disabled={busy || !info.acceptOpen} onClick={() => void decide(true)}>許可する</button>
              <button type="button" className="ghost" disabled={busy} onClick={() => void decide(false)}>拒否する</button>
              {!info.acceptOpen && <button type="button" className="ghost" disabled={busy} onClick={() => void load()}>再読み込み</button>}
            </div>
          </>
        )}
        {!info && !error && <p className="muted">読み込み中…</p>}
      </div>
    </div>
  );
}
