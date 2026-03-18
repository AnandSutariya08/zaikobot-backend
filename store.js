import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PRODUCTS_FILE = path.join(__dirname, "data", "products.json");
const CHANNELS_FILE = path.join(__dirname, "data", "channels.json");
const SCHEDULES_FILE = path.join(__dirname, "data", "schedules.json");
const SUBSCRIBERS_FILE = path.join(__dirname, "data", "subscribers.json");
const INTERVALS_FILE = path.join(__dirname, "data", "intervals.json");
const JOIN_INVITES_FILE = path.join(__dirname, "data", "join-invites.json");

const log = (message, meta) => {
  if (meta === undefined) {
    console.log(`[store] ${message}`);
    return;
  }
  console.log(`[store] ${message}`, meta);
};

async function readJsonArray(filePath, label) {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const data = Array.isArray(parsed) ? parsed : [];
    log(`${label} loaded`, { count: data.length });
    return data;
  } catch {
    log(`${label} file missing or invalid, returning empty list`);
    return [];
  }
}

async function writeJsonArray(filePath, label, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
  log(`${label} saved`, { count: value.length });
}

export async function getProducts() {
  return readJsonArray(PRODUCTS_FILE, "products");
}

export async function saveProducts(products) {
  await writeJsonArray(PRODUCTS_FILE, "products", products);
}

export async function addProduct(product) {
  const products = await getProducts();
  const next = [product, ...products];
  await saveProducts(next);
  log("product added", { id: product.id, name: product.name });
  return product;
}

export async function deleteProduct(id) {
  const products = await getProducts();
  const next = products.filter((p) => p.id !== id);
  await saveProducts(next);
  log("product delete requested", { id, removed: next.length !== products.length });
  return next.length !== products.length;
}

export async function updateProduct(id, patch) {
  const products = await getProducts();
  const index = products.findIndex((p) => p.id === id);
  if (index < 0) {
    log("product update requested but not found", { id });
    return null;
  }

  const updated = {
    ...products[index],
    ...patch,
    id: products[index].id,
    updatedAt: new Date().toISOString()
  };
  products[index] = updated;
  await saveProducts(products);
  log("product updated", { id, name: updated.name });
  return updated;
}

export async function getChannels() {
  return readJsonArray(CHANNELS_FILE, "channels");
}

export async function saveChannels(channels) {
  await writeJsonArray(CHANNELS_FILE, "channels", channels);
}

export async function addChannel(channel) {
  const channels = await getChannels();
  const next = [channel, ...channels.filter((c) => c.channelIdNormalized !== channel.channelIdNormalized)];
  await saveChannels(next);
  log("channel added", { id: channel.id, name: channel.name, channelIdNormalized: channel.channelIdNormalized });
  return channel;
}

export async function deleteChannel(id) {
  const channels = await getChannels();
  const next = channels.filter((c) => c.id !== id);
  await saveChannels(next);
  log("channel delete requested", { id, removed: next.length !== channels.length });
  return next.length !== channels.length;
}

export async function getSchedules() {
  return readJsonArray(SCHEDULES_FILE, "schedules");
}

export async function saveSchedules(schedules) {
  await writeJsonArray(SCHEDULES_FILE, "schedules", schedules);
}

export async function addSchedule(schedule) {
  const schedules = await getSchedules();
  const next = [schedule, ...schedules];
  await saveSchedules(next);
  log("schedule added", { id: schedule.id, channelId: schedule.channelId, sendAt: schedule.sendAt });
  return schedule;
}

export async function updateSchedule(id, patch) {
  const schedules = await getSchedules();
  const index = schedules.findIndex((s) => s.id === id);
  if (index < 0) {
    log("schedule update requested but not found", { id });
    return null;
  }
  const updated = { ...schedules[index], ...patch, id: schedules[index].id };
  schedules[index] = updated;
  await saveSchedules(schedules);
  log("schedule updated", { id, status: updated.status });
  return updated;
}

export async function deleteSchedule(id) {
  const schedules = await getSchedules();
  const next = schedules.filter((s) => s.id !== id);
  await saveSchedules(next);
  log("schedule delete requested", { id, removed: next.length !== schedules.length });
  return next.length !== schedules.length;
}

export async function getSubscribers() {
  return readJsonArray(SUBSCRIBERS_FILE, "subscribers");
}

export async function saveSubscribers(subscribers) {
  await writeJsonArray(SUBSCRIBERS_FILE, "subscribers", subscribers);
}

export async function addSubscribersBulk(channelIdNormalized, numbers) {
  const subscribers = await getSubscribers();
  const cleaned = [...new Set(numbers.map((x) => String(x || "").trim()).filter(Boolean))];
  const now = new Date().toISOString();
  const byKey = new Map(subscribers.map((row) => [`${row.channelIdNormalized}|${row.number}`, row]));
  let inserted = 0;

  for (const number of cleaned) {
    const key = `${channelIdNormalized}|${number}`;
    if (byKey.has(key)) continue;
    byKey.set(key, {
      id: `${channelIdNormalized}:${number}`,
      channelIdNormalized,
      number,
      createdAt: now
    });
    inserted += 1;
  }

  const next = Array.from(byKey.values());
  await saveSubscribers(next);
  log("subscribers bulk add", { channelIdNormalized, requested: cleaned.length, inserted });
  return { requested: cleaned.length, inserted, skipped: cleaned.length - inserted };
}

export async function getIntervals() {
  return readJsonArray(INTERVALS_FILE, "intervals");
}

export async function saveIntervals(intervals) {
  await writeJsonArray(INTERVALS_FILE, "intervals", intervals);
}

export async function addInterval(intervalJob) {
  const intervals = await getIntervals();
  const next = [intervalJob, ...intervals];
  await saveIntervals(next);
  log("interval added", {
    id: intervalJob.id,
    everySeconds: intervalJob.everySeconds ?? intervalJob.everyMinutes,
    channels: intervalJob.channelIds.length,
    products: intervalJob.productIds.length
  });
  return intervalJob;
}

export async function updateInterval(id, patch) {
  const intervals = await getIntervals();
  const index = intervals.findIndex((s) => s.id === id);
  if (index < 0) {
    log("interval update requested but not found", { id });
    return null;
  }
  const updated = { ...intervals[index], ...patch, id: intervals[index].id };
  intervals[index] = updated;
  await saveIntervals(intervals);
  log("interval updated", { id, status: updated.status, lastRunAt: updated.lastRunAt || "" });
  return updated;
}

export async function getJoinInvites() {
  return readJsonArray(JOIN_INVITES_FILE, "join invites");
}

export async function saveJoinInvites(invites) {
  await writeJsonArray(JOIN_INVITES_FILE, "join invites", invites);
}

export async function addJoinInvitesBulk(invites) {
  const current = await getJoinInvites();
  const next = [...invites, ...current];
  await saveJoinInvites(next);
  log("join invites bulk add", { requested: invites.length, stored: next.length });
  return invites;
}

export async function findJoinInvite(channelIdNormalized, inviteLink) {
  const invites = await getJoinInvites();
  return (
    invites.find(
      (row) =>
        row.channelIdNormalized === channelIdNormalized &&
        row.inviteLink === inviteLink &&
        row.status === "issued"
    ) || null
  );
}

export async function updateJoinInvite(id, patch) {
  const invites = await getJoinInvites();
  const index = invites.findIndex((row) => row.id === id);
  if (index < 0) {
    log("join invite update requested but not found", { id });
    return null;
  }

  const updated = {
    ...invites[index],
    ...patch,
    id: invites[index].id,
    updatedAt: new Date().toISOString()
  };
  invites[index] = updated;
  await saveJoinInvites(invites);
  log("join invite updated", { id, status: updated.status });
  return updated;
}
