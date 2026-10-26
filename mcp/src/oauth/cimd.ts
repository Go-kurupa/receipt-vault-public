import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { isCimdClientId } from './pure';

const TIMEOUT_MS = 5_000;
const MAX_BYTES = 64 * 1024;
const CACHE_MS = 5 * 60_000;
const CACHE_MAX = 50;

/** 内部・予約アドレス（SSRF 対策）。IPv4 射影の IPv6 も IPv4 として判定する。 */
export function isBlockedAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const ip = mapped ? mapped[1]! : address;
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') ||
      v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff') || v.startsWith('64:ff9b') || v.startsWith('2001:db8');
  }
  return true;
}

/** 接続時に解決された全アドレスを検査する（確認後の差し替え＝DNS リバインディングを防ぐ）。 */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '', 0);
    const list = addresses as unknown as LookupAddress[];
    if (!list.length || list.some((a) => isBlockedAddress(a.address))) {
      return callback(Object.assign(new Error('blocked address'), { code: 'EBLOCKED' }), '', 0);
    }
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
};

export type FetchJson = (url: string) => Promise<unknown>;

/** https・既定ポート・リダイレクト不追従・5 秒・64KB・JSON のみ。 */
export const fetchJsonGuarded: FetchJson = (url) =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    // IPv6 の直接指定は hostname が [::1] の形になるので、角括弧を外してから判定する。
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (u.protocol !== 'https:' || u.port !== '' || isIP(host)) return reject(new Error('bad_url'));
    const req = request(u, { method: 'GET', lookup: guardedLookup, timeout: TIMEOUT_MS, headers: { accept: 'application/json' } }, (res) => {
      if (res.statusCode !== 200) {
        // 本文は読まずに接続ごと切る（リダイレクト先へ進まない・送り続けられても受けない）。
        req.destroy();
        return reject(new Error(`status_${res.statusCode}`));
      }
      let size = 0;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          req.destroy(new Error('too_large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new Error('not_json'));
        }
      });
      res.on('error', reject);
    });
    // timeout は無通信時間だけなので、名前解決から受信完了までの総時間も別に打ち切る。
    const total = setTimeout(() => req.destroy(new Error('timeout')), TIMEOUT_MS);
    const done = () => clearTimeout(total);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => { done(); reject(e); });
    req.on('close', done);
    req.end();
  });

const cache = new Map<string, { at: number; doc: unknown }>();

/** CIMD 文書を取得（成功だけ短時間キャッシュ）。 */
export async function fetchCimd(clientId: string, fetchJson: FetchJson = fetchJsonGuarded, now = Date.now()): Promise<unknown> {
  if (!isCimdClientId(clientId)) throw new Error('bad_client_id');
  const hit = cache.get(clientId);
  if (hit && now - hit.at < CACHE_MS) return hit.doc;
  const doc = await fetchJson(clientId);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(clientId, { at: now, doc });
  return doc;
}

export function clearCimdCache(): void {
  cache.clear();
}
