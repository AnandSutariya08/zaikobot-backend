import dotenv from "dotenv";

dotenv.config();

const BOT_TOKEN = '8761982010:AAGBzQXPEvw3e0NGZJudYhV9sidF16tPh0c';
const CHANNEL_ID_RAW = '1003828022465';
const TELEGRAM_MAX_RETRIES = Math.max(0, Math.floor(Number(process.env.TELEGRAM_MAX_RETRIES || 5) || 5));
const TELEGRAM_SEND_DELAY_MS = Math.max(0, Math.floor(Number(process.env.TELEGRAM_SEND_DELAY_MS || 300) || 300));
const log = (message, meta) => {
  if (meta === undefined) {
    console.log(`[telegram] ${message}`);
    return;
  }
  console.log(`[telegram] ${message}`, meta);
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterSeconds(payload) {
  const fromParams = Number(payload?.parameters?.retry_after);
  if (Number.isFinite(fromParams) && fromParams > 0) {
    return Math.floor(fromParams);
  }

  const description = String(payload?.description || "");
  const match = description.match(/retry after\s+(\d+)/i);
  if (match?.[1]) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return 0;
}

function validateConfig() {
  if (!BOT_TOKEN) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN in server/.env");
  }
}

function normalizeChannelId(channelId) {
  const value = String(channelId || "").trim();
  if (!value) return value;

  if (/^-?\d+$/.test(value)) {
    if (value.startsWith("-100")) return value;
    if (value.startsWith("100")) return `-${value}`;
    return value;
  }

  return value.startsWith("@") ? value : `@${value}`;
}

function getChannelId(channelIdInput = "") {
  validateConfig();
  if (String(channelIdInput || "").trim()) {
    return normalizeChannelId(channelIdInput);
  }
  if (CHANNEL_ID_RAW) {
    return normalizeChannelId(CHANNEL_ID_RAW);
  }
  throw new Error("Channel ID is required");
}

async function telegramRequest(method, body, attempt = 0) {
  validateConfig();
  let res;
  try {
    log("telegram request", { method, attempt });
    res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch {
    if (attempt < TELEGRAM_MAX_RETRIES) {
      const waitMs = Math.min(1000 * (attempt + 1), 5000);
      log("telegram request network error, retrying", { method, attempt, waitMs });
      await sleep(waitMs);
      return telegramRequest(method, body, attempt + 1);
    }
    log("telegram request failed: network error", { method, attempt });
    throw new Error("Cannot reach Telegram API after retries");
  }

  const data = await res.json();
  if (!data.ok) {
    const retryAfter = parseRetryAfterSeconds(data);
    if (retryAfter > 0 && attempt < TELEGRAM_MAX_RETRIES) {
      const waitMs = (retryAfter + 1) * 1000;
      log("telegram rate limited, retrying", { method, attempt, retryAfterSeconds: retryAfter });
      await sleep(waitMs);
      return telegramRequest(method, body, attempt + 1);
    }
    log("telegram request failed", { method, description: data.description || "unknown error" });
    throw new Error(data.description || "Telegram API request failed");
  }
  if (attempt > 0) {
    log("telegram request success after retry", { method, attempt });
  } else {
    log("telegram request success", { method });
  }
  return data;
}

function buildText(product) {
  const price = String(product.price || "").trim();
  const priceLine = price ? `Price: ${price}` : "";
  const details = product.details || "No details";
  const sections = [String(product.name || "").trim(), priceLine, details].filter(Boolean);
  return sections.join("\n\n");
}

function shouldFallbackToMessage(errorMessage) {
  const msg = String(errorMessage || "").toLowerCase();
  return (
    msg.includes("wrong type of the web page content") ||
    msg.includes("failed to get http url content") ||
    msg.includes("wrong file identifier") ||
    msg.includes("http url specified")
  );
}

function getExtFromContentType(contentType) {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("image/jpeg")) return "jpg";
  if (type.includes("image/png")) return "png";
  if (type.includes("image/webp")) return "webp";
  if (type.includes("image/gif")) return "gif";
  return "jpg";
}

function sanitizeFileName(name, fallback = "product.jpg") {
  const clean = String(name || "").trim().replace(/[^a-zA-Z0-9._-]/g, "_");
  return clean || fallback;
}

async function sendPhotoWithFormData(formData, attempt = 0) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
    method: "POST",
    body: formData
  });

  const data = await res.json();
  if (!data.ok) {
    const retryAfter = parseRetryAfterSeconds(data);
    if (retryAfter > 0 && attempt < TELEGRAM_MAX_RETRIES) {
      const waitMs = (retryAfter + 1) * 1000;
      log("sendPhoto rate limited, retrying upload", { attempt, retryAfterSeconds: retryAfter });
      await sleep(waitMs);
      return sendPhotoWithFormData(formData, attempt + 1);
    }
    throw new Error(data.description || "Telegram sendPhoto upload failed");
  }
  return data;
}

async function sendPhotoFromBase64(channelId, product, caption) {
  const raw = String(product.imageBase64 || "").trim();
  if (!raw) {
    throw new Error("Missing imageBase64 payload");
  }

  const mime = String(product.imageMime || "image/jpeg").trim();
  if (!mime.toLowerCase().startsWith("image/")) {
    throw new Error(`Invalid image mime type (${mime})`);
  }

  const base64 = raw.includes(",") ? raw.split(",")[1] : raw;
  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length) {
    throw new Error("Invalid base64 image data");
  }

  const ext = getExtFromContentType(mime);
  const fileName = sanitizeFileName(product.imageFileName, `product.${ext}`);
  const formData = new FormData();
  formData.append("chat_id", channelId);
  formData.append("caption", String(caption || "").slice(0, 1024));
  formData.append("photo", new Blob([buffer], { type: mime }), fileName);

  const data = await sendPhotoWithFormData(formData);
  log("photo upload from base64 success", { fileName, mime });
  return data;
}

function extractMetaImageUrl(html) {
  const source = String(html || "");
  const patterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i
  ];

  for (const regex of patterns) {
    const match = source.match(regex);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function resolveRelativeUrl(baseUrl, value) {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return "";
  }
}

async function downloadUrl(url) {
  return fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
      Accept: "*/*"
    }
  });
}

async function sendPhotoByUpload(channelId, imageUrl, caption, depth = 0) {
  log("downloading image for upload fallback", { imageUrl, depth });
  const imageRes = await downloadUrl(imageUrl);
  if (!imageRes.ok) {
    throw new Error(`Image download failed (${imageRes.status})`);
  }

  const contentType = imageRes.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("image/")) {
    if (depth === 0 && contentType.toLowerCase().includes("text/html")) {
      const html = await imageRes.text();
      const rawMetaImage = extractMetaImageUrl(html);
      const metaImage = resolveRelativeUrl(imageUrl, rawMetaImage);
      if (metaImage) {
        log("web page URL detected, trying meta image", { from: imageUrl, metaImage });
        return sendPhotoByUpload(channelId, metaImage, caption, depth + 1);
      }
    }
    throw new Error(`Downloaded content is not an image (${contentType || "unknown"})`);
  }

  const arrayBuffer = await imageRes.arrayBuffer();
  const ext = getExtFromContentType(contentType);
  const fileName = `product.${ext}`;
  const formData = new FormData();
  formData.append("chat_id", channelId);
  formData.append("caption", String(caption || "").slice(0, 1024));
  formData.append("photo", new Blob([arrayBuffer], { type: contentType }), fileName);

  const data = await sendPhotoWithFormData(formData);
  log("photo upload fallback success", { fileName, contentType });
  return data;
}

export async function verifyChannel(channelIdInput) {
  const normalizedChannelId = getChannelId(channelIdInput);
  log("verifying setup", { channelIdRaw: CHANNEL_ID_RAW, channelIdNormalized: normalizedChannelId });
  const me = await telegramRequest("getMe", {});
  const chat = await telegramRequest("getChat", { chat_id: normalizedChannelId });
  log("setup verified", { botUsername: me.result?.username || "", chatTitle: chat.result?.title || "" });
  return {
    ok: true,
    botUsername: me.result?.username || "",
    channelIdRaw: CHANNEL_ID_RAW,
    channelIdNormalized: normalizedChannelId,
    chatTitle: chat.result?.title || "",
    chatType: chat.result?.type || ""
  };
}

export async function verifyTelegramSetup() {
  return verifyChannel(CHANNEL_ID_RAW);
}

export async function createJoinRequestInviteLink(channelIdInput, options = {}) {
  const channelId = getChannelId(channelIdInput);
  const payload = {
    chat_id: channelId,
    creates_join_request: true
  };

  const name = String(options.name || "").trim();
  if (name) payload.name = name.slice(0, 32);

  const expireDate = Number(options.expireDate);
  if (Number.isFinite(expireDate) && expireDate > 0) {
    payload.expire_date = Math.floor(expireDate);
  }

  const response = await telegramRequest("createChatInviteLink", payload);
  return {
    ok: true,
    channelId,
    inviteLink: response.result?.invite_link || "",
    expireDate: response.result?.expire_date || 0,
    createsJoinRequest: Boolean(response.result?.creates_join_request),
    name: response.result?.name || ""
  };
}

export async function approveJoinRequest(channelIdInput, userId) {
  const channelId = getChannelId(channelIdInput);
  const normalizedUserId = Number(userId);
  if (!Number.isFinite(normalizedUserId)) {
    throw new Error("userId must be a valid number");
  }

  await telegramRequest("approveChatJoinRequest", {
    chat_id: channelId,
    user_id: Math.floor(normalizedUserId)
  });

  return { ok: true, channelId, userId: Math.floor(normalizedUserId) };
}

export async function sendProductToChannel(product, channelIdInput = "") {
  const channelId = getChannelId(channelIdInput);
  const text = buildText(product);
  log("sending product", {
    id: product.id,
    name: product.name,
    hasImageUrl: Boolean(product.imageUrl),
    hasImageBase64: Boolean(product.imageBase64)
  });

  if (product.imageBase64) {
    const uploaded = await sendPhotoFromBase64(channelId, product, text);
    return { ...uploaded, transport: "photo-upload-base64" };
  }

  if (product.imageUrl) {
    try {
      const response = await telegramRequest("sendPhoto", {
        chat_id: channelId,
        photo: product.imageUrl,
        caption: text.slice(0, 1024)
      });
      return { ...response, transport: "photo" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!shouldFallbackToMessage(message)) {
        log("send photo failed without fallback", { id: product.id, error: message });
        throw error;
      }

      log("send photo failed, falling back to uploaded file", { id: product.id, reason: message });
      const fallback = await sendPhotoByUpload(channelId, product.imageUrl, text);
      return { ...fallback, fallbackUsed: true, fallbackReason: message, transport: "photo-upload-fallback" };
    }
  }

  const response = await telegramRequest("sendMessage", {
    chat_id: channelId,
    text
  });
  return { ...response, transport: "message" };
}

export async function sendProductsBulk(products, options = {}) {
  const channelIdInput = options.channelId || "";
  const results = [];
  log("bulk send started", { count: products.length, channelId: getChannelId(channelIdInput) });

  for (const product of products) {
    try {
      const response = await sendProductToChannel(product, channelIdInput);
      results.push({
        id: product.id,
        name: product.name,
        ok: true,
        transport: response.transport || "unknown",
        fallbackUsed: Boolean(response.fallbackUsed),
        fallbackReason: response.fallbackReason || "",
        response
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("product send failed", { id: product.id, name: product.name, error: message });
      results.push({
        id: product.id,
        name: product.name,
        ok: false,
        error: message
      });
    }

    if (TELEGRAM_SEND_DELAY_MS > 0) {
      await sleep(TELEGRAM_SEND_DELAY_MS);
    }
  }

  log("bulk send finished", {
    sent: results.filter((x) => x.ok).length,
    failed: results.filter((x) => !x.ok).length
  });
  return results;
}
