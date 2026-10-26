import { parseArgs } from 'node:util';
import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { OWNER_EMAIL } from '../src/auth.js';
import { selectActiveKey } from '../src/key-scopes.js';
// Grants or removes receipts:organize on an existing key, found by its label.
// Prints only the label, the key id prefix and the resulting scopes (never key material).
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { label: { type: 'string' }, organize: { type: 'string' } }, strict: true });
  const label = values.label?.trim();
  if (!label || (values.organize !== 'true' && values.organize !== 'false')) throw new Error('Invalid arguments');
  const scopes = values.organize === 'true' ? ['receipts:read', 'receipts:organize'] : ['receipts:read'];
  const app = initializeApp({ credential: applicationDefault(), projectId: 'your-firebase-project-id' }, 'set-key-scopes-script');
  const db = getFirestore(app);
  const snap = await db.collection('mcp_keys').where('ownerEmail', '==', OWNER_EMAIL).where('label', '==', label).get();
  const target = selectActiveKey(snap.docs);
  if (!target) throw new Error('Key not unique');
  await target.ref.update({ scopes, scopesUpdatedAt: FieldValue.serverTimestamp() });
  console.log(JSON.stringify({ label, keyIdPrefix: target.id.slice(0, 8), scopes }));
}
main().catch(() => {
  console.error('権限を変更できませんでした。ラベル（有効な鍵が 1 つだけか）・アカウント・権限を確認してください。');
  process.exitCode = 1;
});
