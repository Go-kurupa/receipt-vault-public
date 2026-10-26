import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { constants } from 'node:fs';
import { mkdir, lstat, open, unlink } from 'node:fs/promises';
import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { ALLOWED_EMAILS } from '../src/auth.js';
import { generateMcpKey, hashMcpKey } from '../src/keys-pure.js';
import { MCP_SCOPES } from '../src/scopes.js';
class InvalidScopeError extends Error {}
// Never create subcollections under mcp_keys: recursive {path=**}/history and
// /channels rule allows expose them; a deny cannot override an allow.
// Put future audit data in a separate collection.
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      label: { type: 'string' },
      scope: { type: 'string', default: 'receipts:read' },
    },
    strict: true,
  });
  const email = values.email?.trim().toLowerCase();
  const label = values.label?.trim();
  const scope = MCP_SCOPES.find((allowed) => allowed === values.scope);
  if (scope === undefined)
    throw new InvalidScopeError(
      '--scope は receipts:read または receipts:organize を指定してください。'
    );
  if (
    !email ||
    !ALLOWED_EMAILS.some((allowed) => allowed === email) ||
    !label ||
    Array.from(label).length > 40
  )
    throw new Error('Invalid arguments');
  const app = initializeApp(
    { credential: applicationDefault(), projectId: 'your-firebase-project-id' },
    'issue-key-script'
  );
  const user = await getAuth(app).getUserByEmail(email);
  if (user.disabled || user.email?.toLowerCase() !== email) throw new Error('User unavailable');
  const dir = join(homedir(), '.config', 'receipt-vault-secrets');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new Error('Insecure directory');
  const slug = `${email}-${label}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-|-$/g, '');
  const path = join(dir, `mcp-key-${slug}.txt`);
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  let issued = false;
  try {
    const key = generateMcpKey();
    const keyId = hashMcpKey(key);
    // Finish the local secret file first so a disk failure cannot leave an active inaccessible key.
    await file.writeFile(key + '\n', 'utf8');
    await file.sync();
    await getFirestore(app)
      .doc(`mcp_keys/${keyId}`)
      .create({
        ownerUid: user.uid,
        ownerEmail: email,
        label,
        // The single window admits receipts:read keys only; organize keys also need read.
        scopes: scope === 'receipts:organize' ? ['receipts:read', 'receipts:organize'] : [scope],
        createdAt: FieldValue.serverTimestamp(),
        createdBy: 'issue-key-script',
      });
    issued = true;
    console.log(path);
    console.log(keyId.slice(0, 8));
    console.log(key.length);
  } finally {
    await file.close();
    if (!issued) await unlink(path);
  }
}
main().catch((error: unknown) => {
  console.error(
    error instanceof InvalidScopeError
      ? error.message
      : '鍵を発行できませんでした。引数・アカウント・保存先の権限を確認してください。'
  );
  process.exitCode = 1;
});
