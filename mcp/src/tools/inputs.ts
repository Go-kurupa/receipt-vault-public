import { z } from 'zod';
export const dateInput = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD で指定してください');
export const amountInput = z.number().int().min(0);
export const limitInput = z.number().int().min(1).max(200);
export const statusInput = z.enum(['未記帳', '記帳済', '要確認']);
export const kindInput = z.enum(['paper', 'digital']);
export const APP_URL = 'https://your-firebase-project-id.web.app/';
