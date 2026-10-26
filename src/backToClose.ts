const MARKER = "receiptVaultOverlay";
const abandoned = new WeakMap<BackEnvironment, Set<string>>();

export interface BackEnvironment {
  history: Pick<History, "state" | "pushState" | "back">;
  addEventListener: (type: "popstate", listener: () => void) => void;
  removeEventListener: (type: "popstate", listener: () => void) => void;
}

// DOM に依存せず履歴の所有権を管理する。閉じた後の戻る操作は処理しない。
export function createBackToClose(env: BackEnvironment, onClose: () => void, canClose: () => boolean) {
  const token = crypto.randomUUID();
  const baseState = env.history.state;
  const entry = { ...baseState, [MARKER]: token };
  let active = true;
  let closing = false;
  env.history.pushState(entry, "");

  function onPop() {
    if (!active || env.history.state?.[MARKER] === token) return;
    if (!closing && !canClose()) {
      env.history.pushState(entry, "");
      return;
    }
    active = false;
    env.removeEventListener("popstate", onPop);
    onClose();
  }
  env.addEventListener("popstate", onPop);

  return {
    close(force = false) {
      if (!active || closing || (!force && !canClose())) return;
      closing = true;
      env.history.back();
    },
    dispose() {
      env.removeEventListener("popstate", onPop);
      if (active && env.history.state?.[MARKER] === token) {
        if (!closing) env.history.back();
      } else if (active) {
        // 認証変更で複数の画面を同時に破棄した場合、下側の履歴も取り除く。
        let tokens = abandoned.get(env);
        if (!tokens) {
          tokens = new Set<string>();
          abandoned.set(env, tokens);
          const pending = tokens;
          const skipAbandoned = () => {
            if (pending.delete(env.history.state?.[MARKER])) env.history.back();
            if (pending.size === 0) {
              env.removeEventListener("popstate", skipAbandoned);
              abandoned.delete(env);
            }
          };
          env.addEventListener("popstate", skipAbandoned);
        }
        tokens.add(token);
      }
      active = false;
    },
  };
}
