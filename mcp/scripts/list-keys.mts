import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
async function main(): Promise<void> {
  const app = initializeApp({ credential: applicationDefault(), projectId: 'your-firebase-project-id' });
  const snap = await getFirestore(app).collection('mcp_keys').get();
  for (const doc of snap.docs) {
    const data = doc.data();
    // JSON escaping prevents labels from injecting extra terminal lines.
    console.log(
      JSON.stringify({
        keyIdPrefix: doc.id.slice(0, 8),
        ownerEmail: data.ownerEmail,
        label: data.label,
        scopes: data.scopes === undefined ? '(なし=無効)' : data.scopes,
        createdAt:
          data.createdAt instanceof Timestamp ? data.createdAt.toDate().toISOString() : null,
        revoked: data.revokedAt !== undefined ? 'yes' : 'no',
      })
    );
  }
}
main().catch(() => {
  console.error('鍵一覧を取得できませんでした。認証と権限を確認してください。');
  process.exitCode = 1;
});
