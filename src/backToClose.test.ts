import { expect, it, vi } from "vitest";
import { createBackToClose, type BackEnvironment } from "./backToClose";

function environment() {
  const stack: unknown[] = [{ page: "app" }];
  let index = 0;
  const listeners = new Set<() => void>();
  const tasks: (() => void)[] = [];
  const env: BackEnvironment = {
    history: {
      get state() { return stack[index]; },
      pushState(state: unknown) { stack.splice(++index); stack.push(state); },
      back() { tasks.push(() => { index--; for (const listener of [...listeners]) listener(); }); },
    },
    addEventListener(_type, listener) { listeners.add(listener); },
    removeEventListener(_type, listener) { listeners.delete(listener); },
  };
  return { env, stack, get index() { return index; }, flush() { while (tasks.length) tasks.shift()!(); } };
}
it("開くと1件追加し、戻ると閉じる", () => {
  const browser = environment(); const close = vi.fn();
  createBackToClose(browser.env, close, () => true);
  expect(browser.stack).toHaveLength(2);
  browser.env.history.back(); browser.flush();
  expect(close).toHaveBeenCalledOnce(); expect(browser.index).toBe(0);
});
it("未保存を破棄しない場合は履歴を戻し、再度戻る操作を受け付ける", () => {
  const browser = environment(); const close = vi.fn(); const confirm = vi.fn().mockReturnValue(false);
  createBackToClose(browser.env, close, confirm);
  browser.env.history.back(); browser.flush();
  expect(close).not.toHaveBeenCalled(); expect(browser.index).toBe(1); expect(browser.stack).toHaveLength(2);
  confirm.mockReturnValue(true);
  browser.env.history.back(); browser.flush(); expect(close).toHaveBeenCalledOnce();
});
it("画面の閉じるボタンも履歴を戻し、連打しても重複しない", () => {
  const browser = environment(); const close = vi.fn();
  const controller = createBackToClose(browser.env, close, () => true);
  controller.close(); controller.close(); browser.flush(); controller.dispose(); browser.flush();
  expect(browser.index).toBe(0); expect(close).toHaveBeenCalledOnce();
});
it("キャンセルと保存成功時の強制終了を処理する", () => {
  const browser = environment(); const close = vi.fn();
  const controller = createBackToClose(browser.env, close, () => false);
  controller.close(); browser.flush(); expect(browser.index).toBe(1);
  controller.close(true); browser.flush(); expect(close).toHaveBeenCalledOnce();
});
it("認証変更で重なった画面を破棄しても履歴を残さない", () => {
  const browser = environment(); const close = vi.fn();
  const upload = createBackToClose(browser.env, close, () => true);
  const detail = createBackToClose(browser.env, close, () => true);
  upload.dispose(); detail.dispose(); browser.flush();
  expect(browser.index).toBe(0); expect(close).not.toHaveBeenCalled();
});
it("重なった画面で戻ると上の画面だけ閉じる", () => {
  const browser = environment(); const uploadClose = vi.fn(); const detailClose = vi.fn();
  const upload = createBackToClose(browser.env, uploadClose, () => true);
  createBackToClose(browser.env, detailClose, () => true);
  browser.env.history.back(); browser.flush();
  expect(detailClose).toHaveBeenCalledOnce(); expect(uploadClose).not.toHaveBeenCalled();
  upload.close(); browser.flush(); expect(browser.index).toBe(0);
});
