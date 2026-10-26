import { parseArgs } from 'node:util';
import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { enabled: { type: 'string' } }, strict: true });
  if (values.enabled !== 'true' && values.enabled !== 'false') throw new Error('Invalid arguments');
  const enabled = values.enabled === 'true';
  const app = initializeApp({ credential: applicationDefault(), projectId: 'your-firebase-project-id' }, 'set-write-script');
  await getFirestore(app).doc('mcp_settings/receipts_write').set({ enabled, updatedAt: FieldValue.serverTimestamp() });
  console.log(enabled);
}
main().catch(() => {
  console.error('書き込み設定を変更できませんでした。引数・アカウント・権限を確認してください。');
  process.exitCode = 1;
});
