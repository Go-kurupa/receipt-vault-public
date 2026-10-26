import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { db } from '../admin';
import { generateMcpKey, hashMcpKey } from '../keys-pure';
import { isOwner, ManageError, parseManageRequest, runManage } from './manage';

const STATUS = { invalid: 'invalid-argument', not_found: 'not-found', revoked: 'failed-precondition', duplicate_label: 'already-exists' } as const;

/** Owner-only management of AI connections. Key material appears only in the issue response. */
export async function handleManage(request: CallableRequest<unknown>) {
  const auth = request.auth;
  if (!auth || !isOwner(auth)) throw new HttpsError('permission-denied', 'このアカウントには権限がありません');
  const parsed = parseManageRequest(request.data);
  if (!parsed.ok) throw new HttpsError('invalid-argument', parsed.error);
  const req = parsed.req;
  let result = 'error';
  try {
    const out = await runManage({ db, generateKey: generateMcpKey, hashKey: hashMcpKey }, req, { uid: auth.uid, email: auth.token.email! });
    result = 'ok';
    return out;
  } catch (error) {
    if (error instanceof ManageError) {
      result = error.code;
      throw new HttpsError(STATUS[error.code], error.message);
    }
    throw new HttpsError('internal', '処理に失敗しました。時間をおいて再度お試しください。');
  } finally {
    logger.info('ai_connections_manage', { action: req.action, ...('keyId' in req ? { keyId: req.keyId.slice(0, 8) } : {}), result });
  }
}
