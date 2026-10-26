import { useEffect, useRef } from "react";
import { createBackToClose } from "./backToClose";

export function useBackToClose(open: boolean, onClose: () => void, canClose: () => boolean = () => true) {
  const callbacks = useRef({ onClose, canClose });
  const lifecycle = useRef({
    controller: null as ReturnType<typeof createBackToClose> | null,
    generation: 0,
  }).current;
  useEffect(() => { callbacks.current = { onClose, canClose }; });

  useEffect(() => {
    const currentGeneration = ++lifecycle.generation;
    if (open && !lifecycle.controller) {
      lifecycle.controller = createBackToClose(window, () => callbacks.current.onClose(), () => callbacks.current.canClose());
    }
    if (!open) {
      lifecycle.controller?.dispose();
      lifecycle.controller = null;
    }
    return () => {
      // StrictMode の再セットアップでは同じ履歴を再利用する。
      queueMicrotask(() => {
        if (lifecycle.generation !== currentGeneration) return;
        lifecycle.controller?.dispose();
        lifecycle.controller = null;
      });
    };
  }, [open, lifecycle]);

  return {
    close: () => lifecycle.controller?.close(),
    dismiss: () => lifecycle.controller?.close(true),
  };
}
