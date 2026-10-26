import { useEffect, useMemo, useRef, useState } from "react";
import type { User } from "firebase/auth";
import { useAuth, logout } from "./useAuth";
import { useReceipts, type ReceiptChain } from "./useReceipts";
import { Login } from "./components/Login";
import { Filters } from "./components/Filters";
import { ReceiptTable } from "./components/ReceiptTable";
import { ReceiptDetail } from "./components/ReceiptDetail";
import { MonthlySummary } from "./components/MonthlySummary";
import { DigitalUpload } from "./components/DigitalUpload";
import { Manual } from "./components/Manual";
import { AiConnections } from "./components/AiConnections";
import { Connect } from "./components/Connect";
import { applyFilters, downloadCsv, emptyCriteria, monthlySummary, toCsv, toJournalCsv } from "./filters";
import { readChainParam } from "./deepLink";
import "./App.css";

export default function App() {
  const { user, loading: authLoading } = useAuth();
  if (authLoading) return <div className="center muted">読み込み中…</div>;
  if (!user) return <Login />;
  // ログイン連携の許可画面。一覧などは読み込まない。
  if (location.pathname === "/connect") return <Connect key={user.uid} />;
  // ユーザーが変わると一覧・詳細・登録フォームをまとめて作り直す。
  return <SignedInApp key={user.uid} user={user} />;
}

function SignedInApp({ user }: { user: User }) {
  const { chains, loading, error, reload } = useReceipts(user.uid);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [criteria, setCriteria] = useState(emptyCriteria);
  const [selected, setSelected] = useState<ReceiptChain | null>(null);
  const [activeTab, setActiveTab] = useState<"list" | "manual" | "ai">("list");
  const uploadCanLeave = useRef<(() => boolean) | null>(null);
  const aiCanLeave = useRef<(() => boolean) | null>(null);

  const deepLinkOpened = useRef(false);
  useEffect(() => {
    if (deepLinkOpened.current || loading || error) return;
    const chainId = readChainParam(location.search);
    const chain = chains.find((c) => c.chainId === chainId);
    if (!chain) return;
    deepLinkOpened.current = true;
    history.replaceState(null, "", location.pathname);
    setSelected(chain);
  }, [chains, loading, error]);

  const filtered = useMemo(() => applyFilters(chains, criteria), [chains, criteria]);
  const buckets = useMemo(() => monthlySummary(filtered), [filtered]);

  async function handleLogout() {
    setLogoutBusy(true);
    setLogoutError(null);
    try {
      await logout();
    } catch {
      setLogoutError("サインアウトできませんでした。通信状況を確認して、もう一度お試しください。");
    } finally {
      setLogoutBusy(false);
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>🧾 Receipt Vault</h1>
        <div className="header-right">
          <span className="muted small">{user.email}</span>
          <button className="ghost" onClick={handleLogout} disabled={logoutBusy}>
            サインアウト
          </button>
        </div>
      </header>

      {logoutError && <p className="error" role="alert">{logoutError}</p>}

      <nav className="tab-nav" role="tablist" aria-label="表示切り替え">
        <button
          type="button"
          id="receipt-list-tab"
          className={`tab-button${activeTab === "list" ? " active" : ""}`}
          role="tab"
          aria-selected={activeTab === "list"}
          aria-controls="receipt-list-panel"
          onClick={() => {
            if (aiCanLeave.current?.() === false) return;
            setActiveTab("list");
          }}
        >
          📋 レシート一覧
        </button>
        <button
          type="button"
          id="manual-tab"
          className={`tab-button${activeTab === "manual" ? " active" : ""}`}
          role="tab"
          aria-selected={activeTab === "manual"}
          aria-controls="manual-panel"
          onClick={() => {
            if (uploadCanLeave.current?.() === false || aiCanLeave.current?.() === false) return;
            setActiveTab("manual");
          }}
        >
          📖 使い方
        </button>
        <button
          type="button"
          id="ai-tab"
          className={`tab-button${activeTab === "ai" ? " active" : ""}`}
          role="tab"
          aria-selected={activeTab === "ai"}
          aria-controls="ai-panel"
          onClick={() => {
            if (uploadCanLeave.current?.() === false) return;
            setActiveTab("ai");
          }}
        >
          🤖 AI 接続
        </button>
      </nav>

      <main>
        {activeTab === "list" ? (
          <div id="receipt-list-panel" role="tabpanel" aria-labelledby="receipt-list-tab">
            <Filters
              value={criteria}
              onChange={setCriteria}
              resultCount={filtered.length}
              totalCount={chains.length}
            />

            <div className="toolbar">
              <button className="ghost" onClick={reload} disabled={loading}>
                {loading ? "更新中…" : "再読み込み"}
              </button>
              <button
                className="primary"
                onClick={() => downloadCsv(`receipts-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(filtered))}
                disabled={filtered.length === 0}
              >
                台帳 CSV 出力
              </button>
              <button
                className="ghost"
                onClick={() =>
                  downloadCsv(`journal-${new Date().toISOString().slice(0, 10)}.csv`, toJournalCsv(filtered))
                }
                disabled={filtered.length === 0}
              >
                仕訳 CSV 出力
              </button>
            </div>

            <DigitalUpload onUploaded={reload} canLeaveRef={uploadCanLeave} />

            {error && (
              <p className="error">
                データを読み込めません: {error}
                <br />
                <span className="small">
                  (Firestore のセキュリティルールでこのアカウントの読み取りが許可されているか確認してください)
                </span>
              </p>
            )}

            {loading && chains.length === 0 ? (
              <p className="muted">レシートを読み込み中…</p>
            ) : (
              <>
                <ReceiptTable chains={filtered} onSelect={setSelected} />
                <MonthlySummary buckets={buckets} />
              </>
            )}
          </div>
        ) : activeTab === "manual" ? (
          <div id="manual-panel" role="tabpanel" aria-labelledby="manual-tab">
            <Manual />
          </div>
        ) : (
          <div id="ai-panel" role="tabpanel" aria-labelledby="ai-tab">
            <AiConnections canLeaveRef={aiCanLeave} />
          </div>
        )}
      </main>

      {selected && (
        <ReceiptDetail
          key={selected.chainId}
          chain={selected}
          onClose={() => setSelected(null)}
          onStatusChanged={reload}
        />
      )}
    </div>
  );
}
