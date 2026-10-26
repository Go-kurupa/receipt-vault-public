import { parseArgs } from 'node:util';
import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
// Never create subcollections under mcp_keys: recursive {path=**}/history and
// /channels rule allows expose them; a deny cannot override an allow.
// Put future audit data in a separate collection.
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'key-id-prefix': { type: 'string' } }, strict: true });
  const prefix = values['key-id-prefix'];
  if (!prefix || !/^[a-f0-9]{8,64}$/.test(prefix)) throw new Error('Invalid prefix');
  const app = initializeApp({ credential: applicationDefault(), projectId: 'your-firebase-project-id' });
  const db = getFirestore(app);
  const matches = await db
    .collection('mcp_keys')
    .orderBy('__name__')
    .startAt(prefix)
    .endAt(prefix + '\uf8ff')
    .limit(2)
    .get();
  if (matches.size !== 1) throw new Error('Prefix must match exactly one key');
  await matches.docs[0].ref.update({
    revokedAt: FieldValue.serverTimestamp(),
    revokedBy: 'revoke-key-script',
  });
  console.log(`${matches.docs[0].id.slice(0, 8)} revoked`);
}
main().catch(() => {
  console.error(
    '鍵を無効化できませんでした。指定文字列が1件だけに一致するか、権限を確認してください。'
  );
  process.exitCode = 1;
});
