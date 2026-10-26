export function authErrorMessage(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : error;
  switch (code) {
    case "auth/popup-blocked": return "ログイン画面がブロックされました。Chromeでポップアップを許可して、もう一度ログインしてください。";
    case "auth/popup-closed-by-user": return "ログイン画面が閉じられました。もう一度ログインしてください。";
    case "auth/cancelled-popup-request": return "ログイン操作が重複しました。少し待ってから、もう一度ログインしてください。";
    case "auth/network-request-failed": return "通信できませんでした。インターネット接続を確認して、もう一度ログインしてください。";
    case "auth/unauthorized-domain": return "このアドレスではログインが許可されていません。管理者にお問い合わせください。";
    default: return "ログインできませんでした。もう一度お試しください。解決しない場合は管理者にお問い合わせください。";
  }
}
