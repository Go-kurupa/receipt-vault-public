// mcp の型検査は画面側のコード (../src) を一部取り込む。
// 画面側は Vite の環境変数 (import.meta.env) を読むので、その型だけをここで宣言する。
interface ImportMeta {
  readonly env: Record<string, string | undefined>;
}
