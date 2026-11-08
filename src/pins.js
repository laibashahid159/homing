// Pinned-tab state and the operations on it.
//
// A pin looks like:
//   { id, homeUrl, title, tabId, createdAt, favorite, folderId }
//
// - `tabId` is the live Chrome tab the pin is linked to, or null when that tab
//   is closed. Closing a pinned tab never removes the pin (same as Arc): click
//   it again and it reopens at its home URL.
// - `favorite` pins show as icons in the grid at the top of the panel.
// - `folderId` puts a (non-favorite) pin inside a folder.
//
// The order of the `pins` array is the display order everywhere.
//
// A folder looks like: { id, name, collapsed }
//
// Read helpers are safe to use anywhere. Functions that write should only be
// called from the background service worker, which runs them one at a time.

const PINS = 'pins';
const FOLDERS = 'folders';

export async function getState() {
  const { [PINS]: pins = [], [FOLDERS]: folders = [] } =
    await chrome.storage.local.get([PINS, FOLDERS]);
  return { pins, folders };
}

export async function getPins() {
  return (await getState()).pins;
}

async function savePins(pins) {
  await chrome.storage.local.set({ [PINS]: pins });
}

async function saveFolders(folders) {
  await chrome.storage.local.set({ [FOLDERS]: folders });
}

/** Compare URLs loosely: ignore the #hash and a trailing slash. */
export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href.replace(/\/$/, '');
  } catch {
    return url;
  }
}

/** True when the pin's tab has navigated away from its home URL. */
export function isDrifted(pin, tab) {
  const current = tab && (tab.url || tab.pendingUrl);
  if (!current) return false;
  return normalizeUrl(current) !== normalizeUrl(pin.homeUrl);
}

export function isPinnable(url) {
  return /^(https?|file):/.test(url || '');
}

async function getTab(tabId) {
  if (tabId == null) return null;
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null; // tab no longer exists
  }
}

async function getPin(id) {
  const pin = (await getPins()).find((p) => p.id === id);
  if (!pin) throw new Error('That pin no longer exists.');
  return pin;
}

async function patchPin(id, patch) {
  const pins = await getPins();
  const i = pins.findIndex((p) => p.id === id);
  if (i < 0) throw new Error('That pin no longer exists.');
  pins[i] = { ...pins[i], ...patch };
  await savePins(pins);
  return pins[i];
}

export async function findPinByTabId(tabId) {
  return (await getPins()).find((p) => p.tabId === tabId) || null;
}

/**
 * Insert `pin` into `pins` next to `anchorId` ('before' or 'after').
 * No anchor (or an anchor that's gone) appends to the end.
 */
function insertPin(pins, pin, anchorId, position, originalIndex = -1) {
  if (anchorId && anchorId === pin.id && originalIndex >= 0) {
    pins.splice(originalIndex, 0, pin); // dropped on itself: stay put
    return;
  }
  const idx = anchorId ? pins.findIndex((p) => p.id === anchorId) : -1;
  if (idx < 0) pins.push(pin);
  else pins.splice(position === 'after' ? idx + 1 : idx, 0, pin);
}

async function validFolderId(folderId) {
  if (!folderId) return null;
  const { folders } = await getState();
  return folders.some((f) => f.id === folderId) ? folderId : null;
}

// ---------- write operations (background only) ----------

/**
 * Pin a tab. `place` optionally says where it goes:
 *   { favorite, folderId, anchorId, position }
 */
export async function pinTab(tab, place = {}) {
  if (!tab || !isPinnable(tab.url)) {
    throw new Error("This page can't be pinned. Try a normal website.");
  }
  const existing = await findPinByTabId(tab.id);
  if (existing) return placePin(existing.id, place);

  const pins = await getPins();
  const favorite = !!place.favorite;
  const pin = {
    id: crypto.randomUUID(),
    homeUrl: tab.url,
    title: tab.title || new URL(tab.url).hostname,
    tabId: tab.id,
    createdAt: Date.now(),
    favorite,
    folderId: favorite ? null : await validFolderId(place.folderId),
  };
  insertPin(pins, pin, place.anchorId, place.position);
  await savePins(pins);
  // Also pin it in Chrome's own tab strip so it looks and behaves pinned.
  await chrome.tabs.update(tab.id, { pinned: true }).catch(() => {});
  return pin;
}

/** Move a pin: into/out of favorites, into a folder, and/or to a new spot. */
export async function placePin(id, { favorite = false, folderId = null, anchorId = null, position = 'before' } = {}) {
  const pins = await getPins();
  const i = pins.findIndex((p) => p.id === id);
  if (i < 0) throw new Error('That pin no longer exists.');
  const [pin] = pins.splice(i, 1);
  pin.favorite = !!favorite;
  pin.folderId = pin.favorite ? null : await validFolderId(folderId);
  insertPin(pins, pin, anchorId, position, i);
  await savePins(pins);
  return pin;
}

export async function unpin(id) {
  const pins = await getPins();
  const pin = pins.find((p) => p.id === id);
  if (!pin) return;
  await savePins(pins.filter((p) => p.id !== id));
  const tab = await getTab(pin.tabId);
  if (tab) await chrome.tabs.update(tab.id, { pinned: false }).catch(() => {});
}

/** Focus the pin's tab, or reopen it at its home URL if it was closed. */
export async function openPin(id, windowId) {
  const pin = await getPin(id);
  const tab = await getTab(pin.tabId);
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return tab;
  }
  const created = await chrome.tabs.create({
    url: pin.homeUrl,
    pinned: true,
    active: true,
    ...(windowId != null && { windowId }),
  });
  await patchPin(id, { tabId: created.id });
  return created;
}

/** Navigate the pin's tab back to its home URL. */
export async function resetPin(id, windowId) {
  const pin = await getPin(id);
  const tab = await getTab(pin.tabId);
  if (!tab) return openPin(id, windowId);
  await chrome.tabs.update(tab.id, { url: pin.homeUrl, active: true });
  return tab;
}

/** Make wherever the tab is right now its new home. */
export async function setHomeToCurrent(id) {
  const pin = await getPin(id);
  const tab = await getTab(pin.tabId);
  if (!tab || !isPinnable(tab.url)) {
    throw new Error("Can't use this page as home.");
  }
  return patchPin(id, { homeUrl: tab.url, title: tab.title || pin.title });
}

// ---------- folders ----------

export async function createFolder(name = 'New folder') {
  const { folders } = await getState();
  const folder = { id: crypto.randomUUID(), name, collapsed: false };
  folders.push(folder);
  await saveFolders(folders);
  return folder;
}

export async function renameFolder(id, name) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Folder name can’t be empty.');
  const { folders } = await getState();
  const folder = folders.find((f) => f.id === id);
  if (!folder) throw new Error('That folder no longer exists.');
  folder.name = clean.slice(0, 60);
  await saveFolders(folders);
  return folder;
}

export async function toggleFolder(id) {
  const { folders } = await getState();
  const folder = folders.find((f) => f.id === id);
  if (!folder) return;
  folder.collapsed = !folder.collapsed;
  await saveFolders(folders);
}

/** Delete a folder. Its pins move out of it; nothing is unpinned. */
export async function deleteFolder(id) {
  const { pins, folders } = await getState();
  for (const p of pins) if (p.folderId === id) p.folderId = null;
  await savePins(pins);
  await saveFolders(folders.filter((f) => f.id !== id));
}

// ---------- keeping tab links in sync ----------

/** A tab was closed: keep the pin, just unlink it. */
export async function forgetTab(tabId) {
  const pins = await getPins();
  let changed = false;
  for (const p of pins) {
    if (p.tabId === tabId) {
      p.tabId = null;
      changed = true;
    }
  }
  if (changed) await savePins(pins);
}

/** Chrome swapped one tab for another (e.g. prerendering). */
export async function replaceTab(addedTabId, removedTabId) {
  const pins = await getPins();
  const pin = pins.find((p) => p.tabId === removedTabId);
  if (!pin) return;
  pin.tabId = addedTabId;
  await savePins(pins);
}

/**
 * Tab IDs don't survive a browser restart, so match pins back up to the
 * restored tabs. Pinned tabs on the exact home URL win; then any pinned tab
 * on the same site.
 *
 * @param {{fresh: boolean}} opts  fresh=true ignores existing links (startup).
 */
export async function relinkTabs({ fresh }) {
  const pins = await getPins();
  const tabs = await chrome.tabs.query({});
  const liveIds = new Set(tabs.map((t) => t.id));
  const claimed = new Set();

  for (const p of pins) {
    if (!fresh && p.tabId != null && liveIds.has(p.tabId)) {
      claimed.add(p.tabId);
    } else {
      p.tabId = null;
    }
  }

  const candidates = tabs.filter((t) => t.pinned);
  const origin = (u) => {
    try { return new URL(u).origin; } catch { return null; }
  };
  const passes = [
    (p, t) => normalizeUrl(t.url) === normalizeUrl(p.homeUrl),
    (p, t) => origin(t.url) && origin(t.url) === origin(p.homeUrl),
  ];
  for (const matches of passes) {
    for (const p of pins) {
      if (p.tabId != null) continue;
      const t = candidates.find((t) => !claimed.has(t.id) && matches(p, t));
      if (t) {
        p.tabId = t.id;
        claimed.add(t.id);
      }
    }
  }
  await savePins(pins);
}
