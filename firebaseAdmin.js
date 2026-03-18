import dotenv from "dotenv";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

dotenv.config();

function getRequiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getEnv(...names) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) return value;
  }
  return "";
}

function normalizePrivateKey(value) {
  return String(value || "").replace(/\\n/g, "\n");
}

function getFirebaseConfigFromEnv() {
  const projectId = getEnv("FIREBASE_PROJECT_ID", "VITE_FIREBASE_PROJECT_ID") || getRequiredEnv("FIREBASE_PROJECT_ID");
  const clientEmail = getRequiredEnv("FIREBASE_CLIENT_EMAIL");
  const privateKey = normalizePrivateKey(getRequiredEnv("FIREBASE_PRIVATE_KEY"));
  const storageBucket = getEnv("FIREBASE_STORAGE_BUCKET", "VITE_FIREBASE_STORAGE_BUCKET") || getRequiredEnv("FIREBASE_STORAGE_BUCKET");
  return { projectId, clientEmail, privateKey, storageBucket };
}

function getFirebaseApp() {
  if (getApps().length > 0) {
    return getApps()[0];
  }

  const config = getFirebaseConfigFromEnv();
  return initializeApp({
    credential: cert({
      projectId: config.projectId,
      clientEmail: config.clientEmail,
      privateKey: config.privateKey
    }),
    storageBucket: config.storageBucket
  });
}

const app = getFirebaseApp();
const databaseId = String(process.env.FIREBASE_DATABASE_ID || "botdata").trim();

export const db = databaseId && databaseId !== "(default)" ? getFirestore(app, databaseId) : getFirestore(app);
export const storage = getStorage(app);
