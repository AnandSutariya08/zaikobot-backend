import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { db } from "../firebaseAdmin.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");

const SOURCES = [
  { file: "products.json", collection: "products" },
  { file: "channels.json", collection: "channels" },
  { file: "schedules.json", collection: "schedules" },
  { file: "subscribers.json", collection: "subscribers" },
  { file: "intervals.json", collection: "intervals" },
  { file: "join-invites.json", collection: "joinInvites" }
];

async function readArray(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function upsertCollection(collectionName, rows) {
  if (rows.length === 0) {
    console.log(`[migrate] ${collectionName}: no rows`);
    return;
  }

  let batch = db.batch();
  let opCount = 0;
  let committed = 0;

  for (const row of rows) {
    const id = String(row?.id || crypto.randomUUID());
    const ref = db.collection(collectionName).doc(id);
    const data = { ...row, id };
    batch.set(ref, data, { merge: true });
    opCount += 1;

    if (opCount === 400) {
      await batch.commit();
      committed += opCount;
      batch = db.batch();
      opCount = 0;
    }
  }

  if (opCount > 0) {
    await batch.commit();
    committed += opCount;
  }

  console.log(`[migrate] ${collectionName}: upserted ${committed}`);
}

async function main() {
  for (const source of SOURCES) {
    const filePath = path.join(dataDir, source.file);
    const rows = await readArray(filePath);
    await upsertCollection(source.collection, rows);
  }
  console.log("[migrate] done");
}

main().catch((error) => {
  console.error("[migrate] failed", error);
  process.exit(1);
});
