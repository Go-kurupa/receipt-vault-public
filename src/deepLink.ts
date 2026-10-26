// MCP の get_receipt が返す画面 URL（?chain=<chainId>）で詳細を直接開くため。
export function readChainParam(search: string): string | null {
  const v = new URLSearchParams(search).get("chain");
  return v && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null;
}
