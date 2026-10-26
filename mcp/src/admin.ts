import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
const app = getApps().find((a) => a.name === '[DEFAULT]') ?? initializeApp();
export const adminAuth = getAuth(app);
export const db = getFirestore(app);
