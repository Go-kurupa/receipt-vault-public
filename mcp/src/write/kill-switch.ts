import type { Firestore } from 'firebase-admin/firestore';
/** No cache: a missing, malformed or unreadable switch always disables writes. */
export async function isReceiptsWriteEnabled(db: Firestore): Promise<boolean> {
  try {
    const snap = await db.doc('mcp_settings/receipts_write').get();
    return snap.exists && snap.data()?.enabled === true;
  } catch { return false; }
}
