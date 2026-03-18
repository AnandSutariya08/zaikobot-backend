import crypto from "node:crypto";
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import sharp from "sharp";
import { storage } from "./firebaseAdmin.js";
import {
  addChannel,
  addProduct,
  addSchedule,
  addSubscribersBulk,
  addInterval,
  deleteChannel,
  deleteProduct,
  deleteSchedule,
  getChannels,
  getIntervals,
  getProducts,
  getSubscribers,
  getJoinInvites,
  getSchedules,
  updateInterval,
  updateJoinInvite,
  updateProduct,
  updateSchedule,
  addJoinInvitesBulk,
  findJoinInvite
} from "./store.js";
import {
  approveJoinRequest,
  createJoinRequestInviteLink,
  sendProductsBulk,
  verifyChannel,
  verifyTelegramSetup
} from "./telegram.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 4000);
const scheduleTimers = new Map();
const intervalTimers = new Map();
const intervalRunning = new Set();

const log = (message, meta) => {
  if (meta === undefined) {
    console.log(`[api] ${message}`);
    return;
  }
  console.log(`[api] ${message}`, meta);
};

function parseDataUrl(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const match = text.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mime: String(match[1] || "").toLowerCase(), base64: String(match[2] || "") };
}

function getExtFromMimeType(mime) {
  const text = String(mime || "").toLowerCase();
  if (text.includes("image/png")) return "png";
  if (text.includes("image/webp")) return "webp";
  if (text.includes("image/gif")) return "gif";
  return "jpg";
}

function sanitizeStorageName(name, fallback) {
  const clean = String(name || "").trim().replace(/[^a-zA-Z0-9._-]/g, "_");
  return clean || fallback;
}

async function uploadProductImageToFirebase({ productId, imageBase64, imageMime, imageFileName }) {
  const parsed = parseDataUrl(imageBase64);
  const mime = (parsed?.mime || String(imageMime || "").trim() || "image/jpeg").toLowerCase();
  const base64 = parsed?.base64 || String(imageBase64 || "").trim();
  if (!base64) return null;

  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length) {
    throw new Error("Invalid imageBase64 payload");
  }

  const ext = getExtFromMimeType(mime);
  const safeFileName = sanitizeStorageName(imageFileName, `product.${ext}`);
  const imageStoragePath = `products/${productId}/${Date.now()}-${safeFileName}`;
  const token = crypto.randomUUID();
  const bucket = storage.bucket();
  const file = bucket.file(imageStoragePath);

  await file.save(buffer, {
    resumable: false,
    contentType: mime,
    metadata: {
      contentType: mime,
      metadata: {
        firebaseStorageDownloadTokens: token
      }
    }
  });

  const encodedPath = encodeURIComponent(imageStoragePath);
  const imageUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodedPath}?alt=media&token=${token}`;
  return { imageUrl, imageMime: mime, imageStoragePath };
}

async function optimizeImageBase64Lossless(imageBase64, imageMimeInput = "") {
  const parsed = parseDataUrl(imageBase64);
  if (!parsed) {
    return { imageBase64: String(imageBase64 || "").trim(), imageMime: String(imageMimeInput || "").trim() };
  }

  const mime = parsed.mime || String(imageMimeInput || "").toLowerCase();
  const input = Buffer.from(parsed.base64, "base64");
  if (input.length === 0) {
    return { imageBase64: String(imageBase64 || "").trim(), imageMime: String(imageMimeInput || "").trim() };
  }

  try {
    let output = input;
    let outputMime = mime;
    if (mime === "image/png") {
      output = await sharp(input).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
    } else if (mime === "image/webp") {
      output = await sharp(input).webp({ lossless: true }).toBuffer();
    } else {
      // Keep JPEG/GIF/SVG/etc unchanged to avoid any quality loss.
      return { imageBase64: String(imageBase64 || "").trim(), imageMime: String(imageMimeInput || mime).trim() };
    }

    if (output.length >= input.length) {
      return { imageBase64: String(imageBase64 || "").trim(), imageMime: String(imageMimeInput || mime).trim() };
    }

    return {
      imageBase64: `data:${outputMime};base64,${output.toString("base64")}`,
      imageMime: outputMime
    };
  } catch {
    return { imageBase64: String(imageBase64 || "").trim(), imageMime: String(imageMimeInput || mime).trim() };
  }
}

function normalizePhoneNumber(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const startsWithPlus = raw.startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  return startsWithPlus ? `+${digits}` : digits;
}

function parseBulkNumbers(input) {
  const text = String(input || "");
  const parts = text.split(/[\s,;\n\r\t]+/).map((item) => normalizePhoneNumber(item)).filter(Boolean);
  const unique = [...new Set(parts)];
  const valid = unique.filter((num) => /^\+?\d{7,15}$/.test(num));
  const invalid = unique.filter((num) => !/^\+?\d{7,15}$/.test(num));
  return { valid, invalid };
}

function normalizeIntervalSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return 0;
  return Math.floor(seconds);
}

function getIntervalSeconds(intervalJob) {
  return normalizeIntervalSeconds(intervalJob?.everySeconds ?? intervalJob?.everyMinutes);
}

function clearScheduleTimer(scheduleId) {
  const timer = scheduleTimers.get(scheduleId);
  if (timer) {
    clearTimeout(timer);
    scheduleTimers.delete(scheduleId);
  }
}

async function executeSchedule(scheduleId) {
  clearScheduleTimer(scheduleId);
  const schedules = await getSchedules();
  const schedule = schedules.find((s) => s.id === scheduleId);
  if (!schedule || schedule.status !== "pending") {
    return;
  }

  log("executing schedule", { scheduleId, channelId: schedule.channelId, productCount: schedule.productIds.length });
  const allProducts = await getProducts();
  const selected = allProducts.filter((p) => schedule.productIds.includes(p.id));
  if (selected.length === 0) {
    await updateSchedule(scheduleId, {
      status: "failed",
      error: "No matching products found at execution time",
      finishedAt: new Date().toISOString()
    });
    return;
  }

  const results = await sendProductsBulk(selected, { channelId: schedule.channelId });
  const sent = results.filter((x) => x.ok).length;
  const failed = results.filter((x) => !x.ok).length;

  await updateSchedule(scheduleId, {
    status: failed > 0 ? "completed_with_errors" : "completed",
    sent,
    failed,
    results,
    finishedAt: new Date().toISOString()
  });
}

function queueSchedule(schedule) {
  if (!schedule || schedule.status !== "pending") return;
  clearScheduleTimer(schedule.id);

  const sendAtMs = new Date(schedule.sendAt).getTime();
  const delay = Number.isFinite(sendAtMs) ? Math.max(0, sendAtMs - Date.now()) : 0;
  const timer = setTimeout(() => {
    executeSchedule(schedule.id).catch((error) => {
      log("scheduled execution failed", { scheduleId: schedule.id, error: error instanceof Error ? error.message : String(error) });
    });
  }, delay);
  scheduleTimers.set(schedule.id, timer);
  log("schedule queued", { scheduleId: schedule.id, delayMs: delay });
}

async function rehydrateSchedules() {
  const schedules = await getSchedules();
  for (const schedule of schedules) {
    if (schedule.status === "pending") {
      queueSchedule(schedule);
    }
  }
}

function clearIntervalTimer(intervalId) {
  const timer = intervalTimers.get(intervalId);
  if (timer) {
    clearInterval(timer);
    intervalTimers.delete(intervalId);
  }
}

async function executeInterval(intervalId) {
  if (intervalRunning.has(intervalId)) return;
  intervalRunning.add(intervalId);
  try {
    const intervals = await getIntervals();
    const intervalJob = intervals.find((s) => s.id === intervalId);
    if (!intervalJob || intervalJob.status !== "active") {
      clearIntervalTimer(intervalId);
      return;
    }

    const allProducts = await getProducts();
    const selected = allProducts.filter((p) => intervalJob.productIds.includes(p.id));
    if (selected.length === 0) {
      await updateInterval(intervalId, {
        lastRunAt: new Date().toISOString(),
        lastError: "No matching products found at run time",
        sent: 0,
        failed: 0
      });
      return;
    }

    let sent = 0;
    let failed = 0;
    for (const channelId of intervalJob.channelIds) {
      const results = await sendProductsBulk(selected, { channelId });
      sent += results.filter((x) => x.ok).length;
      failed += results.filter((x) => !x.ok).length;
    }

    await updateInterval(intervalId, {
      lastRunAt: new Date().toISOString(),
      lastError: "",
      sent,
      failed
    });
  } catch (error) {
    await updateInterval(intervalId, {
      lastRunAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : String(error)
    });
  } finally {
    intervalRunning.delete(intervalId);
  }
}

function startIntervalTimer(intervalJob) {
  if (!intervalJob || intervalJob.status !== "active") return;
  clearIntervalTimer(intervalJob.id);
  const everySeconds = getIntervalSeconds(intervalJob);
  if (everySeconds < 1) return;
  const timer = setInterval(() => {
    executeInterval(intervalJob.id).catch((error) => {
      log("interval execution failed", { intervalId: intervalJob.id, error: error instanceof Error ? error.message : String(error) });
    });
  }, everySeconds * 1000);
  intervalTimers.set(intervalJob.id, timer);
  log("interval started", { intervalId: intervalJob.id, everySeconds });
}

async function rehydrateIntervals() {
  const intervals = await getIntervals();
  for (const intervalJob of intervals) {
    if (intervalJob.status === "active") {
      startIntervalTimer(intervalJob);
    }
  }
}

app.use(cors());
app.use(express.json({ limit: "15mb" }));
app.use((req, res, next) => {
  const startedAt = Date.now();
  log("request started", { method: req.method, path: req.path });
  res.on("finish", () => {
    log("request completed", {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - startedAt
    });
  });
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "telegram-product-server" });
});

app.get("/api/telegram/check", async (req, res) => {
  try {
    const channelId = String(req.query.channelId || "");
    const data = channelId ? await verifyChannel(channelId) : await verifyTelegramSetup();
    return res.json(data);
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      hint: "Use valid channel ID (@username or -100...) and add bot as admin with posting permission."
    });
  }
});

app.get("/api/channels", async (_req, res) => {
  const channels = await getChannels();
  res.json({ ok: true, channels });
});

app.post("/api/channels", async (req, res) => {
  const { channelId } = req.body ?? {};
  if (!channelId || typeof channelId !== "string") {
    return res.status(400).json({ ok: false, error: "channelId is required" });
  }

  try {
    const verified = await verifyChannel(channelId);
    const channel = {
      id: crypto.randomUUID(),
      name: String(verified.chatTitle || verified.channelIdNormalized).trim(),
      channelIdRaw: channelId.trim(),
      channelIdNormalized: verified.channelIdNormalized,
      chatTitle: verified.chatTitle || "",
      chatType: verified.chatType || "",
      createdAt: new Date().toISOString()
    };
    await addChannel(channel);
    return res.status(201).json({ ok: true, channel });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.delete("/api/channels/:id", async (req, res) => {
  const removed = await deleteChannel(req.params.id);
  if (!removed) {
    return res.status(404).json({ ok: false, error: "channel not found" });
  }
  return res.json({ ok: true });
});

app.get("/api/subscribers", async (req, res) => {
  const channelId = String(req.query.channelId || "").trim();
  const subscribers = await getSubscribers();
  const list = channelId ? subscribers.filter((x) => x.channelIdNormalized === channelId) : subscribers;
  return res.json({ ok: true, subscribers: list });
});

app.get("/api/join-invites", async (req, res) => {
  const channelId = String(req.query.channelId || "").trim();
  const number = normalizePhoneNumber(req.query.number);
  const invites = await getJoinInvites();
  const list = invites.filter((row) => {
    if (channelId && row.channelIdNormalized !== channelId) return false;
    if (number && row.number !== number) return false;
    return true;
  });
  return res.json({ ok: true, invites: list });
});

app.post("/api/subscribers/bulk", async (req, res) => {
  const { channelId, numbers, rawNumbers } = req.body ?? {};
  if (!channelId || typeof channelId !== "string") {
    return res.status(400).json({ ok: false, error: "channelId is required" });
  }

  const payload =
    Array.isArray(numbers) ? numbers.join("\n") : typeof rawNumbers === "string" ? rawNumbers : String(numbers || "");
  const { valid, invalid } = parseBulkNumbers(payload);
  if (valid.length === 0) {
    return res.status(400).json({ ok: false, error: "No valid phone numbers found", invalid });
  }

  const channels = await getChannels();
  const exists = channels.some((c) => c.channelIdNormalized === channelId);
  if (!exists) {
    return res.status(404).json({ ok: false, error: "Selected channel not found" });
  }

  const result = await addSubscribersBulk(channelId, valid);
  return res.status(201).json({
    ok: true,
    channelId,
    ...result,
    invalid,
    note:
      "Numbers are stored for this channel. Telegram bot API cannot directly subscribe phone numbers to channels."
  });
});

app.post("/api/join-invites/bulk", async (req, res) => {
  const { channelId, numbers, rawNumbers, expireMinutes } = req.body ?? {};
  if (!channelId || typeof channelId !== "string") {
    return res.status(400).json({ ok: false, error: "channelId is required" });
  }

  const payload =
    Array.isArray(numbers) ? numbers.join("\n") : typeof rawNumbers === "string" ? rawNumbers : String(numbers || "");
  const { valid, invalid } = parseBulkNumbers(payload);
  if (valid.length === 0) {
    return res.status(400).json({ ok: false, error: "No valid phone numbers found", invalid });
  }

  let verified;
  try {
    verified = await verifyChannel(channelId);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }

  const ttlMinutes = Math.max(1, Math.floor(Number(expireMinutes ?? 60) || 60));
  const expireDate = Math.floor(Date.now() / 1000) + ttlMinutes * 60;
  const nowIso = new Date().toISOString();

  const successes = [];
  const failures = [];
  for (const number of valid) {
    try {
      const invite = await createJoinRequestInviteLink(verified.channelIdNormalized, {
        name: `Lead ${number.slice(-6)}`,
        expireDate
      });
      if (!invite.inviteLink) {
        failures.push({ number, error: "Telegram did not return invite link" });
        continue;
      }
      successes.push({
        id: crypto.randomUUID(),
        channelIdNormalized: verified.channelIdNormalized,
        channelIdRaw: channelId.trim(),
        number,
        inviteLink: invite.inviteLink,
        status: "issued",
        createdAt: nowIso,
        expiresAt: invite.expireDate ? new Date(invite.expireDate * 1000).toISOString() : ""
      });
    } catch (error) {
      failures.push({ number, error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (successes.length > 0) {
    await addJoinInvitesBulk(successes);
  }

  return res.status(201).json({
    ok: true,
    channelId: verified.channelIdNormalized,
    requested: valid.length,
    created: successes.length,
    failed: failures.length,
    invalid,
    links: successes.map((row) => ({
      id: row.id,
      number: row.number,
      inviteLink: row.inviteLink,
      expiresAt: row.expiresAt
    })),
    failures
  });
});

app.get("/api/products", async (_req, res) => {
  const products = await getProducts();
  res.json({ ok: true, products });
});

app.post("/api/products", async (req, res) => {
  const { name, price, details, imageUrl, imageBase64, imageMime, imageFileName } = req.body ?? {};
  if (!name || typeof name !== "string") {
    return res.status(400).json({ ok: false, error: "name is required" });
  }

  try {
    const productId = crypto.randomUUID();
    const optimized = await optimizeImageBase64Lossless(imageBase64, imageMime);
    const uploaded = optimized.imageBase64
      ? await uploadProductImageToFirebase({
          productId,
          imageBase64: optimized.imageBase64,
          imageMime: optimized.imageMime,
          imageFileName
        })
      : null;

    const product = {
      id: productId,
      name: name.trim(),
      price: String(price ?? "").trim(),
      details: String(details ?? "").trim(),
      imageUrl: uploaded?.imageUrl || String(imageUrl ?? "").trim(),
      imageBase64: "",
      imageMime: uploaded?.imageMime || String(imageMime ?? "").trim(),
      imageFileName: String(imageFileName ?? "").trim(),
      imageStoragePath: uploaded?.imageStoragePath || "",
      createdAt: new Date().toISOString()
    };
    await addProduct(product);
    return res.status(201).json({ ok: true, product });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.put("/api/products/:id", async (req, res) => {
  const { name, price, details, imageUrl, imageBase64, imageMime, imageFileName } = req.body ?? {};
  if (!name || typeof name !== "string") {
    return res.status(400).json({ ok: false, error: "name is required" });
  }

  try {
    const optimized = await optimizeImageBase64Lossless(imageBase64, imageMime);
    const uploaded = optimized.imageBase64
      ? await uploadProductImageToFirebase({
          productId: req.params.id,
          imageBase64: optimized.imageBase64,
          imageMime: optimized.imageMime,
          imageFileName
        })
      : null;

    const updated = await updateProduct(req.params.id, {
      name: name.trim(),
      price: String(price ?? "").trim(),
      details: String(details ?? "").trim(),
      imageUrl: uploaded?.imageUrl || String(imageUrl ?? "").trim(),
      imageBase64: "",
      imageMime: uploaded?.imageMime || String(imageMime ?? "").trim(),
      imageFileName: String(imageFileName ?? "").trim(),
      imageStoragePath: uploaded?.imageStoragePath || ""
    });

    if (!updated) {
      return res.status(404).json({ ok: false, error: "product not found" });
    }

    return res.json({ ok: true, product: updated });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete("/api/products/:id", async (req, res) => {
  const removed = await deleteProduct(req.params.id);
  if (!removed) {
    return res.status(404).json({ ok: false, error: "product not found" });
  }
  return res.json({ ok: true });
});

app.post("/api/send", async (req, res) => {
  const { productIds, channelIds, channelId } = req.body ?? {};
  if (!Array.isArray(productIds) || productIds.length === 0) {
    return res.status(400).json({ ok: false, error: "productIds must be a non-empty array" });
  }

  const all = await getProducts();
  const selected = all.filter((p) => productIds.includes(p.id));
  if (selected.length === 0) {
    return res.status(404).json({ ok: false, error: "No matching products found" });
  }

  const normalizedChannels = Array.isArray(channelIds)
    ? channelIds.map((c) => String(c || "").trim()).filter(Boolean)
    : String(channelId || "").trim()
      ? [String(channelId || "").trim()]
      : [];

  if (normalizedChannels.length === 0) {
    return res.status(400).json({ ok: false, error: "Select at least one channel" });
  }

  log("multi-channel send requested", {
    productCount: selected.length,
    channelCount: [...new Set(normalizedChannels)].length,
    channels: [...new Set(normalizedChannels)]
  });

  const perChannel = [];
  const flatResults = [];
  for (const cid of [...new Set(normalizedChannels)]) {
    const results = await sendProductsBulk(selected, { channelId: cid });
    const sent = results.filter((x) => x.ok).length;
    const failed = results.filter((x) => !x.ok).length;
    perChannel.push({ channelId: cid, sent, failed, results });
    for (const row of results) {
      flatResults.push({ ...row, channelId: cid });
    }
  }

  const sent = flatResults.filter((x) => x.ok).length;
  const failed = flatResults.filter((x) => !x.ok).length;
  return res.json({
    ok: true,
    sent,
    failed,
    channels: perChannel,
    results: flatResults
  });
});

app.get("/api/intervals", async (_req, res) => {
  const intervals = await getIntervals();
  return res.json({ ok: true, intervals });
});

app.post("/api/intervals", async (req, res) => {
  const { productIds, channelIds, everySeconds, everyMinutes } = req.body ?? {};
  if (!Array.isArray(productIds) || productIds.length === 0) {
    return res.status(400).json({ ok: false, error: "productIds must be a non-empty array" });
  }

  if (!Array.isArray(channelIds) || channelIds.length === 0) {
    return res.status(400).json({ ok: false, error: "channelIds must be a non-empty array" });
  }

  const seconds = normalizeIntervalSeconds(everySeconds ?? everyMinutes);
  if (seconds < 1) {
    return res.status(400).json({ ok: false, error: "everySeconds must be at least 1" });
  }

  const intervalJob = {
    id: crypto.randomUUID(),
    productIds: [...new Set(productIds.map((x) => String(x || "").trim()).filter(Boolean))],
    channelIds: [...new Set(channelIds.map((x) => String(x || "").trim()).filter(Boolean))],
    everySeconds: seconds,
    status: "active",
    createdAt: new Date().toISOString(),
    lastRunAt: "",
    lastError: "",
    sent: 0,
    failed: 0
  };

  if (intervalJob.productIds.length === 0 || intervalJob.channelIds.length === 0) {
    return res.status(400).json({ ok: false, error: "Select at least one product and one channel" });
  }

  await addInterval(intervalJob);
  startIntervalTimer(intervalJob);
  return res.status(201).json({ ok: true, interval: intervalJob });
});

app.post("/api/intervals/:id/start", async (req, res) => {
  const updated = await updateInterval(req.params.id, { status: "active", lastError: "" });
  if (!updated) {
    return res.status(404).json({ ok: false, error: "interval not found" });
  }
  startIntervalTimer(updated);
  return res.json({ ok: true, interval: updated });
});

app.post("/api/intervals/:id/stop", async (req, res) => {
  clearIntervalTimer(req.params.id);
  const updated = await updateInterval(req.params.id, { status: "stopped" });
  if (!updated) {
    return res.status(404).json({ ok: false, error: "interval not found" });
  }
  return res.json({ ok: true, interval: updated });
});

app.get("/api/schedules", async (_req, res) => {
  const schedules = await getSchedules();
  res.json({ ok: true, schedules });
});

app.post("/api/schedules", async (req, res) => {
  const { channelId, productIds, sendAt } = req.body ?? {};
  if (!channelId || typeof channelId !== "string") {
    return res.status(400).json({ ok: false, error: "channelId is required" });
  }
  if (!Array.isArray(productIds) || productIds.length === 0) {
    return res.status(400).json({ ok: false, error: "productIds must be a non-empty array" });
  }

  const when = new Date(sendAt);
  if (!sendAt || Number.isNaN(when.getTime())) {
    return res.status(400).json({ ok: false, error: "sendAt must be a valid datetime" });
  }

  try {
    const verified = await verifyChannel(channelId);
    const schedule = {
      id: crypto.randomUUID(),
      channelId: verified.channelIdNormalized,
      channelName: verified.chatTitle || verified.channelIdNormalized,
      productIds: [...new Set(productIds)],
      sendAt: when.toISOString(),
      status: "pending",
      createdAt: new Date().toISOString(),
      sent: 0,
      failed: 0,
      results: []
    };
    await addSchedule(schedule);
    queueSchedule(schedule);
    return res.status(201).json({ ok: true, schedule });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.delete("/api/schedules/:id", async (req, res) => {
  clearScheduleTimer(req.params.id);
  const removed = await deleteSchedule(req.params.id);
  if (!removed) {
    return res.status(404).json({ ok: false, error: "schedule not found" });
  }
  return res.json({ ok: true });
});

app.post("/api/telegram/webhook", async (req, res) => {
  const secret = String(process.env.TELEGRAM_WEBHOOK_SECRET || "").trim();
  if (secret) {
    const incoming = String(req.headers["x-telegram-bot-api-secret-token"] || "");
    if (incoming !== secret) {
      return res.status(401).json({ ok: false, error: "Invalid webhook secret" });
    }
  }

  const update = req.body ?? {};
  const joinRequest = update.chat_join_request;
  if (!joinRequest) {
    return res.json({ ok: true, handled: false });
  }

  const channelId = String(joinRequest.chat?.id ?? "").trim();
  const inviteLink = String(joinRequest.invite_link?.invite_link || "").trim();
  const userId = Number(joinRequest.from?.id);
  if (!channelId || !inviteLink || !Number.isFinite(userId)) {
    return res.json({ ok: true, handled: true, approved: false, reason: "missing_required_fields" });
  }

  const issuedInvite = await findJoinInvite(channelId, inviteLink);
  if (!issuedInvite) {
    return res.json({ ok: true, handled: true, approved: false, reason: "invite_not_issued_by_system" });
  }

  try {
    await approveJoinRequest(channelId, userId);
    const approvedAt = new Date().toISOString();
    const updated = await updateJoinInvite(issuedInvite.id, {
      status: "approved",
      approvedAt,
      approvedUserId: Math.floor(userId),
      approvedUsername: String(joinRequest.from?.username || ""),
      approvedName: [joinRequest.from?.first_name, joinRequest.from?.last_name].filter(Boolean).join(" "),
      joinRequestDate: joinRequest.date
        ? new Date(Number(joinRequest.date) * 1000).toISOString()
        : ""
    });

    return res.json({
      ok: true,
      handled: true,
      approved: true,
      inviteId: issuedInvite.id,
      number: issuedInvite.number,
      record: updated
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateJoinInvite(issuedInvite.id, {
      status: "approve_failed",
      lastError: message,
      lastAttemptAt: new Date().toISOString()
    });
    return res.status(400).json({ ok: false, handled: true, approved: false, error: message, inviteId: issuedInvite.id });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  rehydrateSchedules().catch((error) => {
    log("schedule rehydrate failed", { error: error instanceof Error ? error.message : String(error) });
  });
  rehydrateIntervals().catch((error) => {
    log("interval rehydrate failed", { error: error instanceof Error ? error.message : String(error) });
  });
});
