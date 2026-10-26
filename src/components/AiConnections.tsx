import { useCallback, useEffect, useState, type RefObject } from "react";
import {
  acceptMinutesLeft, canOrganize, closeAiAccept, describeOrigin, describeScopes, errorMessage, formatJstDate, issueAiKey, listAiConnections,
  openAiAccept, revokeAiGrant, revokeAiKey, setAiOrganize, setAiWrite, type AiConnectionList, type IssuedKey,
} from "../aiConnections";

const MCP_URL = "https://asia-northeast1-your-firebase-project-id.cloudfunctions.net/receiptsMcp";
const HARK_URL = "https://example.invalid/hark/mcp";
const OAUTH_URL = "https://your-firebase-project-id.web.app/mcp";

interface Props {
  canLeaveRef?: RefObject<(() => boolean) | null>;
}

export function AiConnections({ canLeaveRef }: Props) {
  const [data, setData] = useState<AiConnectionList | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [organize, setOrganize] = useState(false);
  // 発行した鍵はこの画面を閉じるまでの 1 回だけ表示する（保存も再表示もしない）。
  const [issued, setIssued] = useState<IssuedKey | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await listAiConnections());
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // 表示中の鍵を、タブ切り替えで黙って捨てない。
  useEffect(() => {
    if (!canLeaveRef) return;
    canLeaveRef.current = () =>
      !issued || copied || window.confirm("まだコピーしていない鍵があります。移動すると二度と表示できません。移動しますか？");
    return () => { canLeaveRef.current = null; };
  });

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleIssue() {
    await run(async () => {
      const result = await issueAiKey(label.trim(), organize);
      setIssued(result);
      setCopied(false);
      setLabel("");
      setOrganize(false);
    });
  }

  async function copyKey() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.key);
      setCopied(true);
    } catch {
      setError("コピーできませんでした。鍵の文字を長押ししてコピーしてください");
    }
  }

  const active = data?.keys.filter((k) => !k.revoked) ?? [];
  const revoked = data?.keys.filter((k) => k.revoked) ?? [];

  return (
    <div className="manual ai-connections">
      {error && <p className="error" role="alert">{error}</p>}

      <section className="manual-section">
        <h2>✍️ AI からの書き込み</h2>
        {data === null ? (
          <p className="muted">読み込み中…</p>
        ) : (
          <>
            <p>
              現在: <strong>{data.writeEnabled ? "許可中" : "停止中"}</strong>
              <span className="muted small">（停止中は、整理権限のある接続でも確定できません）</span>
            </p>
            <button
              type="button"
              className={data.writeEnabled ? "ghost" : "primary"}
              disabled={busy}
              onClick={() => {
                if (data.writeEnabled && !window.confirm("AI からの書き込みを止めますか？")) return;
                void run(() => setAiWrite(!data.writeEnabled));
              }}
            >
              {data.writeEnabled ? "書き込みを止める" : "書き込みを再開する"}
            </button>
          </>
        )}
      </section>

      <section className="manual-section">
        <h2>🤖 つながっている AI</h2>
        {active.length === 0 && data !== null && <p className="muted">有効な接続はありません</p>}
        <ul className="ai-key-list">
          {active.map((k) => (
            <li key={k.keyId}>
              <div>
                <strong>{k.label}</strong> <span className="badge">{describeScopes(k.scopes)}</span>
                <div className="muted small">作成 {formatJstDate(k.createdAt)}・{describeOrigin(k.createdBy)}・識別 {k.keyId.slice(0, 8)}</div>
              </div>
              <div className="ai-key-actions">
                <button type="button" className="ghost" disabled={busy} onClick={() => void run(() => setAiOrganize(k.keyId, !canOrganize(k)))}>
                  {canOrganize(k) ? "整理権限を外す" : "整理権限を付ける"}
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm(`「${k.label}」の接続を取り消しますか？取り消すと元に戻せません。`)) return;
                    void run(() => revokeAiKey(k.keyId));
                  }}
                >
                  取り消す
                </button>
              </div>
            </li>
          ))}
        </ul>
        {revoked.length > 0 && (
          <details>
            <summary className="muted small">取り消し済み（{revoked.length} 件）</summary>
            <ul className="small muted">
              {revoked.map((k) => <li key={k.keyId}>{k.label}（作成 {formatJstDate(k.createdAt)}）</li>)}
            </ul>
          </details>
        )}
        <button type="button" className="ghost" disabled={busy} onClick={() => void run(async () => {})}>再読み込み</button>
      </section>

      <section className="manual-section">
        <h2>🔐 ログイン連携（ChatGPT・Claude）</h2>
        {data !== null && (() => {
          const minutes = acceptMinutesLeft(data.acceptUntil, Date.now());
          return (
            <>
              <p>
                新しい接続の受付: <strong>{minutes > 0 ? `受付中（あと約 ${minutes} 分・1 回だけ）` : "閉じています"}</strong>
              </p>
              <p className="small muted">
                受付中に、AI 側でコネクタ（URL <code>{OAUTH_URL}</code>）を追加 → Google でログイン → 許可、の順で接続します。許可すると受付は自動で閉じます。
              </p>
              <button type="button" className={minutes > 0 ? "ghost" : "primary"} disabled={busy}
                onClick={() => void run(() => (minutes > 0 ? closeAiAccept() : openAiAccept()))}>
                {minutes > 0 ? "受付を閉じる" : "新しい接続を受け付ける（10 分）"}
              </button>
            </>
          );
        })()}
        <ul className="ai-key-list">
          {(data?.grants ?? []).filter((g) => !g.revoked).map((g) => (
            <li key={g.grantId}>
              <div>
                <strong>{g.vendor}</strong>（{g.clientName}） <span className="badge">{describeScopes(g.scopes)}</span>
                <div className="muted small">許可 {formatJstDate(g.createdAt)}</div>
              </div>
              <div className="ai-key-actions">
                <button type="button" className="ghost" disabled={busy} onClick={() => {
                  if (!window.confirm(`${g.vendor} の接続を取り消しますか？`)) return;
                  void run(() => revokeAiGrant(g.grantId));
                }}>取り消す</button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="manual-section">
        <h2>🔑 新しい接続キーを作る</h2>
        <p className="small muted">Hark Pro など、鍵を貼り付けて使う AI 用です。鍵はこの場で 1 回だけ表示されます。</p>
        {issued ? (
          <div className="ai-issued" role="status">
            <p><strong>「{issued.label}」の鍵（{describeScopes(issued.scopes)}）</strong></p>
            <code className="ai-key-value">{issued.key}</code>
            <div className="ai-key-actions">
              <button type="button" className="primary" onClick={() => void copyKey()}>{copied ? "コピーしました" : "コピー"}</button>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  if (!copied && !window.confirm("まだコピーしていません。閉じると二度と表示できません。閉じますか？")) return;
                  setIssued(null);
                }}
              >
                閉じる
              </button>
            </div>
            <p className="small muted">AI の設定欄に貼り付けたら「閉じる」を押してください。紛失したら取り消して作り直します。</p>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (label.trim() && !busy) void handleIssue();
            }}
          >
            <label>
              名前（例: hark-read）
              <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} required />
            </label>
            <label className="ai-check">
              <input type="checkbox" checked={organize} onChange={(e) => setOrganize(e.target.checked)} />
              整理（科目・状態などの書き込み）も許可する
            </label>
            <button type="submit" className="primary" disabled={busy || !label.trim()}>鍵を作る</button>
          </form>
        )}
      </section>

      <section className="manual-section">
        <h2>🔌 つなぎ方</h2>
        <ul>
          <li>Claude: 設定 → コネクタ → カスタム追加。URL <code>{MCP_URL}</code>、ヘッダー <code>authorization</code> に <code>Bearer 鍵</code></li>
          <li>Hark Pro: URL <code>{HARK_URL}</code>、トークン欄に鍵だけ（Bearer は付けない）</li>
          <li>権限の付け外しは、つないだままで次の会話から反映されます</li>
        </ul>
      </section>
    </div>
  );
}
