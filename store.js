import { db } from "./firebaseAdmin.js";

const COLLECTIONS = {
  products: "products",
  productGroups: "productGroups",
  channels: "channels",
  schedules: "schedules",
  subscribers: "subscribers",
  intervals: "intervals",
  joinInvites: "joinInvites"
};

const log = (message, meta) => {
  if (meta === undefined) {
    console.log(`[store] ${message}`);
    return;
  }
  console.log(`[store] ${message}`, meta);
};

function collectionRef(name) {
  return db.collection(name);
}

function sortNewestFirst(rows) {
  return [...rows].sort((a, b) => {
    const aTime = new Date(a.updatedAt || a.createdAt || 0).getTime();
    const bTime = new Date(b.updatedAt || b.createdAt || 0).getTime();
    return bTime - aTime;
  });
}

async function readCollection(name, label) {
  const snapshot = await collectionRef(name).get();
  const rows = snapshot.docs.map((doc) => {
    const data = doc.data() || {};
    return { id: data.id || doc.id, ...data };
  });
  log(`${label} loaded`, { count: rows.length });
  return rows;
}

async function replaceCollection(name, label, rows) {
  const snapshot = await collectionRef(name).get();
  const batch = db.batch();
  for (const doc of snapshot.docs) {
    batch.delete(doc.ref);
  }
  for (const row of rows) {
    if (!row?.id) continue;
    batch.set(collectionRef(name).doc(String(row.id)), row);
  }
  await batch.commit();
  log(`${label} saved`, { count: rows.length });
}

async function upsertById(name, row) {
  if (!row?.id) {
    throw new Error("Cannot upsert document without id");
  }
  await collectionRef(name).doc(String(row.id)).set(row);
  return row;
}

async function deleteById(name, id) {
  const ref = collectionRef(name).doc(String(id));
  const doc = await ref.get();
  if (!doc.exists) return false;
  await ref.delete();
  return true;
}

// Products
export async function getProducts() {
  return sortNewestFirst(await readCollection(COLLECTIONS.products, "products"));
}

export async function saveProducts(products) {
  await replaceCollection(COLLECTIONS.products, "products", products);
}

export async function addProduct(product) {
  await upsertById(COLLECTIONS.products, product);
  log("product added", { id: product.id, name: product.name });
  return product;
}

export async function deleteProduct(id) {
  const removed = await deleteById(COLLECTIONS.products, id);
  log("product delete requested", { id, removed });
  return removed;
}

export async function updateProduct(id, patch) {
  const ref = collectionRef(COLLECTIONS.products).doc(String(id));
  const doc = await ref.get();
  if (!doc.exists) {
    log("product update requested but not found", { id });
    return null;
  }
  const current = doc.data() || {};
  const updated = {
    ...current,
    ...patch,
    id: current.id || id,
    updatedAt: new Date().toISOString()
  };
  await ref.set(updated);
  log("product updated", { id, name: updated.name });
  return updated;
}

// Product groups
export async function getProductGroups() {
  return sortNewestFirst(await readCollection(COLLECTIONS.productGroups, "product groups"));
}

export async function saveProductGroups(groups) {
  await replaceCollection(COLLECTIONS.productGroups, "product groups", groups);
}

export async function addProductGroup(group) {
  await upsertById(COLLECTIONS.productGroups, group);
  log("product group added", { id: group.id, name: group.name, productCount: (group.productIds || []).length });
  return group;
}

export async function updateProductGroup(id, patch) {
  const ref = collectionRef(COLLECTIONS.productGroups).doc(String(id));
  const doc = await ref.get();
  if (!doc.exists) {
    log("product group update requested but not found", { id });
    return null;
  }
  const current = doc.data() || {};
  const updated = {
    ...current,
    ...patch,
    id: current.id || id,
    updatedAt: new Date().toISOString()
  };
  await ref.set(updated);
  log("product group updated", { id, name: updated.name, productCount: (updated.productIds || []).length });
  return updated;
}

export async function deleteProductGroup(id) {
  const removed = await deleteById(COLLECTIONS.productGroups, id);
  log("product group delete requested", { id, removed });
  return removed;
}

// Channels
export async function getChannels() {
  return sortNewestFirst(await readCollection(COLLECTIONS.channels, "channels"));
}

export async function saveChannels(channels) {
  await replaceCollection(COLLECTIONS.channels, "channels", channels);
}

export async function addChannel(channel) {
  const channels = await getChannels();
  const next = [channel, ...channels.filter((c) => c.channelIdNormalized !== channel.channelIdNormalized)];
  await saveChannels(next);
  log("channel added", { id: channel.id, name: channel.name, channelIdNormalized: channel.channelIdNormalized });
  return channel;
}

export async function deleteChannel(id) {
  const removed = await deleteById(COLLECTIONS.channels, id);
  log("channel delete requested", { id, removed });
  return removed;
}

// Schedules
export async function getSchedules() {
  return sortNewestFirst(await readCollection(COLLECTIONS.schedules, "schedules"));
}

export async function saveSchedules(schedules) {
  await replaceCollection(COLLECTIONS.schedules, "schedules", schedules);
}

export async function addSchedule(schedule) {
  await upsertById(COLLECTIONS.schedules, schedule);
  log("schedule added", { id: schedule.id, channelId: schedule.channelId, sendAt: schedule.sendAt });
  return schedule;
}

export async function updateSchedule(id, patch) {
  const ref = collectionRef(COLLECTIONS.schedules).doc(String(id));
  const doc = await ref.get();
  if (!doc.exists) {
    log("schedule update requested but not found", { id });
    return null;
  }
  const current = doc.data() || {};
  const updated = { ...current, ...patch, id: current.id || id };
  await ref.set(updated);
  log("schedule updated", { id, status: updated.status });
  return updated;
}

export async function deleteSchedule(id) {
  const removed = await deleteById(COLLECTIONS.schedules, id);
  log("schedule delete requested", { id, removed });
  return removed;
}

// Subscribers
export async function getSubscribers() {
  return sortNewestFirst(await readCollection(COLLECTIONS.subscribers, "subscribers"));
}

export async function saveSubscribers(subscribers) {
  await replaceCollection(COLLECTIONS.subscribers, "subscribers", subscribers);
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

// Intervals
export async function getIntervals() {
  return sortNewestFirst(await readCollection(COLLECTIONS.intervals, "intervals"));
}

export async function saveIntervals(intervals) {
  await replaceCollection(COLLECTIONS.intervals, "intervals", intervals);
}

export async function addInterval(intervalJob) {
  await upsertById(COLLECTIONS.intervals, intervalJob);
  log("interval added", {
    id: intervalJob.id,
    everySeconds: intervalJob.everySeconds ?? intervalJob.everyMinutes,
    channels: intervalJob.channelIds.length,
    products: intervalJob.productIds.length
  });
  return intervalJob;
}

export async function updateInterval(id, patch) {
  const ref = collectionRef(COLLECTIONS.intervals).doc(String(id));
  const doc = await ref.get();
  if (!doc.exists) {
    log("interval update requested but not found", { id });
    return null;
  }
  const current = doc.data() || {};
  const updated = { ...current, ...patch, id: current.id || id };
  await ref.set(updated);
  log("interval updated", { id, status: updated.status, lastRunAt: updated.lastRunAt || "" });
  return updated;
}

// Join invites
export async function getJoinInvites() {
  return sortNewestFirst(await readCollection(COLLECTIONS.joinInvites, "join invites"));
}

export async function saveJoinInvites(invites) {
  await replaceCollection(COLLECTIONS.joinInvites, "join invites", invites);
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
  const ref = collectionRef(COLLECTIONS.joinInvites).doc(String(id));
  const doc = await ref.get();
  if (!doc.exists) {
    log("join invite update requested but not found", { id });
    return null;
  }

  const current = doc.data() || {};
  const updated = {
    ...current,
    ...patch,
    id: current.id || id,
    updatedAt: new Date().toISOString()
  };
  await ref.set(updated);
  log("join invite updated", { id, status: updated.status });
  return updated;
}
