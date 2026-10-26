export type SubmissionFunction = "uploadDigitalReceipt" | "updateReceiptStatus" | "correctReceipt";

export interface SubmissionBase {
  chainId: string;
  docId: string;
  version: number;
}

export interface PendingSubmission {
  requestId: string;
  fingerprint: string;
  fn: SubmissionFunction;
  createdAt: number;
  base?: SubmissionBase;
}

type PendingStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const STORAGE_KEY = "receiptVault.pendingSubmissions";
export const PENDING_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const FUNCTIONS: SubmissionFunction[] = ["uploadDigitalReceipt", "updateReceiptStatus", "correctReceipt"];
const DEFINITIVE_ERRORS = new Set([
  "invalid-argument", "already-exists", "not-found", "failed-precondition", "permission-denied",
  "unauthenticated", "out-of-range", "unimplemented",
]);

function isDefinitiveError(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" && DEFINITIVE_ERRORS.has(code.replace(/^functions\//, ""));
}

function isSubmissionBase(value: unknown): value is SubmissionBase {
  return value !== null && typeof value === "object" &&
    "chainId" in value && typeof value.chainId === "string" && value.chainId.length > 0 &&
    "docId" in value && typeof value.docId === "string" && value.docId.length > 0 &&
    "version" in value && typeof value.version === "number" && Number.isInteger(value.version) && value.version > 0;
}

// 保存できない環境でも、同じ画面内では要求IDを維持する。
export function createPendingSubmissionStore(
  storage: () => PendingStorage | null = () => window.localStorage,
  now: () => number = Date.now,
) {
  let entries: PendingSubmission[] = [];
  let storageFailed = false;

  function save() {
    if (storageFailed) return;
    try {
      const target = storage();
      if (entries.length) target?.setItem(STORAGE_KEY, JSON.stringify(entries));
      else target?.removeItem(STORAGE_KEY);
    } catch {
      storageFailed = true;
      // 容量不足・プライベートモードでも送信は続行する。
    }
  }

  function load() {
    try {
      const target = storageFailed ? null : storage();
      if (target) {
        const raw = target.getItem(STORAGE_KEY);
        const parsed: unknown = raw === null ? [] : JSON.parse(raw);
        entries = Array.isArray(parsed) ? parsed.filter((entry): entry is PendingSubmission =>
          entry !== null && typeof entry === "object" &&
          typeof entry.requestId === "string" && /^[A-Za-z0-9-]{8,100}$/.test(entry.requestId) &&
          typeof entry.fingerprint === "string" && /^[a-f0-9]{64}$/.test(entry.fingerprint) &&
          FUNCTIONS.includes(entry.fn) && typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt) &&
          (entry.base === undefined || isSubmissionBase(entry.base)),
        ).map(({ requestId, fingerprint, fn, createdAt, base }) => ({
          requestId, fingerprint, fn, createdAt,
          ...(base ? { base: { chainId: base.chainId, docId: base.docId, version: base.version } } : {}),
        })) : [];
      }
    } catch {
      storageFailed = true;
      // 読取り拒否・破損時はメモリ上の記録を使う。
    }
    entries = entries.filter((entry) => now() - entry.createdAt >= 0 && now() - entry.createdAt < PENDING_MAX_AGE);
    save();
  }

  load();
  return {
    forFingerprint(fn: SubmissionFunction, fingerprint: string, base?: SubmissionBase): PendingSubmission {
      load();
      const existing = entries.find((entry) => entry.fn === fn && entry.fingerprint === fingerprint);
      if (existing) return existing;
      const entry = { fn, fingerprint, requestId: crypto.randomUUID(), createdAt: now(), ...(base ? { base } : {}) };
      entries.push(entry);
      save();
      return entry;
    },
    settle(requestId: string, error?: unknown): boolean {
      if (error !== undefined && !isDefinitiveError(error)) return false;
      load();
      entries = entries.filter((entry) => entry.requestId !== requestId);
      save();
      return true;
    },
  };
}

// 入力のキー順に依存せず照合する。入力内容・原本は保存せず、照合ハッシュと版の識別子だけを使う。
export async function fingerprintSubmission(input: unknown): Promise<string> {
  const canonical = JSON.stringify(input, (_key, value: unknown) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    }
    return value;
  });
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createSubmissionRequest(fn: SubmissionFunction, store = createPendingSubmissionStore()) {
  let pending: PendingSubmission | null = null;
  return {
    async forInput(input: unknown, base?: SubmissionBase): Promise<string> {
      pending = store.forFingerprint(fn, await fingerprintSubmission(base ? { input, base } : input), base);
      return pending.requestId;
    },
    complete(error?: unknown): void {
      if (pending && store.settle(pending.requestId, error)) pending = null;
    },
    reset(): void {
      // 画面を閉じても、結果不明の要求は消さず次回の同じ入力で再利用する。
      pending = null;
    },
  };
}
