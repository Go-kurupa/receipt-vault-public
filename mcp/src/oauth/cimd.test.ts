import { beforeEach, expect, test, vi } from 'vitest';
import { clearCimdCache, fetchCimd, fetchJsonGuarded, isBlockedAddress } from './cimd';

beforeEach(() => clearCimdCache());

test.each([
  ['10.0.0.1', true], ['127.0.0.1', true], ['169.254.169.254', true], ['172.20.1.1', true], ['192.168.0.19', true], ['100.64.0.1', true],
  ['0.0.0.0', true], ['::1', true], ['fd00::1', true], ['fe80::1', true], ['::ffff:127.0.0.1', true], ['::ffff:10.1.1.1', true],
  ['8.8.8.8', false], ['104.18.32.47', false], ['2606:4700::6810:84e5', false], ['not-an-ip', true],
])('blocked %s -> %s', (ip, blocked) => expect(isBlockedAddress(ip)).toBe(blocked));

test('rejects non-https, explicit ports and literal IPs before any network', async () => {
  await expect(fetchJsonGuarded('http://chatgpt.com/x')).rejects.toThrow('bad_url');
  await expect(fetchJsonGuarded('https://chatgpt.com:444/x')).rejects.toThrow('bad_url');
  await expect(fetchJsonGuarded('https://127.0.0.1/x')).rejects.toThrow('bad_url');
});

test('caches only successful fetches for a short time', async () => {
  const id = 'https://chatgpt.com/oauth/client.json';
  const fetchJson = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({ client_id: id });
  await expect(fetchCimd(id, fetchJson, 0)).rejects.toThrow('timeout');
  await expect(fetchCimd(id, fetchJson, 1)).resolves.toEqual({ client_id: id });
  await fetchCimd(id, fetchJson, 2);
  expect(fetchJson).toHaveBeenCalledTimes(2);
  await fetchCimd(id, fetchJson, 10 * 60_000);
  expect(fetchJson).toHaveBeenCalledTimes(3);
});

test('rejects bracketed IPv6 literals (review M2)', async () => {
  await expect(fetchJsonGuarded('https://[::1]/client.json')).rejects.toThrow('bad_url');
  await expect(fetchJsonGuarded('https://[::ffff:127.0.0.1]/client.json')).rejects.toThrow('bad_url');
});

test('refuses client ids that are not https URLs with a path', async () => {
  await expect(fetchCimd('https://chatgpt.com/', vi.fn())).rejects.toThrow('bad_client_id');
});
