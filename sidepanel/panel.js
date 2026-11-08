import { getState, isDrifted, isPinnable } from '../src/pins.js';

const favoritesEl = document.getElementById('favorites');
const pinnedEl = document.getElementById('pinned');
const todayEl = document.getElementById('today');
const menuEl = document.getElementById('menu');
const toastEl = document.getElementById('toast');

let windowId = null;
let editingFolderId = null; // folder whose name is being edited
let dragging = null;        // { kind: 'pin' | 'tab', id }
let pendingRender = false;

// ---------- small helpers ----------

async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, windowId, ...payload });
  if (res && !res.ok) showToast(res.error);
  return res;
}

let toastTimer;
function showToast(text) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 2500);
}

function faviconUrl(pageUrl) {
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', pageUrl);
  url.searchParams.set('size', '32');
  return url.toString();
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const ICONS = {
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  reset: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  pin: '<path d="M9 3h6l-1 7 4 3H6l4-3z"/><path d="M12 13v8"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
};

function icon(name) {
  const span = el('span');
  // Static markup from the ICONS table above — never user data.
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return span.firstElementChild;
}

function iconButton(label, iconName, className, onClick) {
  const b = el('button', className);
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.append(icon(iconName));
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function favicon(url) {
  const img = el('img', 'favicon');
  img.alt = '';
  img.src = faviconUrl(url);
  return img;
}

// ---------- context menu ----------

function showMenu(x, y, items) {
  menuEl.replaceChildren();
  for (const item of items) {
    if (item === '-') { menuEl.append(el('hr')); continue; }
    if (item.label && !item.action) { menuEl.append(el('div', 'label', item.label)); continue; }
    const b = el('button', item.danger ? 'danger' : '', item.text);
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.addEventListener('click', () => { hideMenu(); item.action(); });
    menuEl.append(b);
  }
  menuEl.hidden = false;
  const { innerWidth: w, innerHeight: h } = window;
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = `${Math.min(x, w - r.width - 8)}px`;
  menuEl.style.top = `${Math.min(y, h - r.height - 8)}px`;
  menuEl.querySelector('button')?.focus();
}

function hideMenu() { menuEl.hidden = true; }

document.addEventListener('click', (e) => { if (!menuEl.contains(e.target)) hideMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMenu(); });
window.addEventListener('blur', hideMenu);

function pinMenuItems(pin, tab, folders) {
  const drifted = isDrifted(pin, tab);
  const items = [{ text: tab ? 'Go to tab' : 'Open', action: () => send('open', { id: pin.id }) }];
  if (drifted) {
    items.push(
      { text: 'Back to home', action: () => send('reset', { id: pin.id }) },
      { text: 'Make this page home', action: () => send('setHome', { id: pin.id }) },
    );
  }
  items.push('-');
  items.push(pin.favorite
    ? { text: 'Remove from Favorites', action: () => send('place', { id: pin.id, place: {} }) }
    : { text: 'Add to Favorites', action: () => send('place', { id: pin.id, place: { favorite: true } }) });

  const targets = folders.filter((f) => f.id !== pin.folderId);
  if (targets.length || pin.folderId) {
    items.push('-', { label: 'Move to folder' });
    for (const f of targets) {
      items.push({ text: f.name, action: () => send('place', { id: pin.id, place: { folderId: f.id } }) });
    }
    if (pin.folderId) {
      items.push({ text: 'Out of folder', action: () => send('place', { id: pin.id, place: {} }) });
    }
  }
  items.push('-', { text: 'Unpin', danger: true, action: () => send('unpin', { id: pin.id }) });
  return items;
}

// ---------- rendering ----------

function renderFavorite(pin, tab, activeTabId, folders) {
  const drifted = isDrifted(pin, tab);
  const b = el('button', 'fav');
  b.type = 'button';
  b.dataset.pinId = pin.id;
  b.draggable = true;
  b.title = drifted ? `${pin.title}\nAway: ${tab.title || tab.url}` : pin.title;
  b.setAttribute('aria-label', pin.title);
  b.classList.toggle('closed', !tab);
  b.classList.toggle('active', !!tab && tab.id === activeTabId);
  const img = el('img');
  img.alt = '';
  img.src = faviconUrl(drifted ? tab.url : pin.homeUrl);
  b.append(img);
  if (drifted) b.append(el('span', 'dot'));
  b.addEventListener('click', () => send('open', { id: pin.id }));
  b.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, pinMenuItems(pin, tab, folders));
  });
  return b;
}

function renderPinRow(pin, tab, activeTabId, folders) {
  const drifted = isDrifted(pin, tab);
  const li = el('li', 'row pin');
  li.dataset.pinId = pin.id;
  li.dataset.folderId = pin.folderId || '';
  li.draggable = true;
  li.tabIndex = 0;
  li.title = `Home: ${pin.homeUrl}`;
  li.classList.toggle('closed', !tab);
  li.classList.toggle('active', !!tab && tab.id === activeTabId);

  const info = el('div', 'info');
  info.append(el('span', 'title', pin.title));
  const sub = el('span', 'sub');
  if (!tab) sub.textContent = `${hostOf(pin.homeUrl)} · closed`;
  else if (drifted) {
    sub.classList.add('drift');
    sub.textContent = `Away: ${tab.title || hostOf(tab.url)}`;
  } else sub.textContent = hostOf(pin.homeUrl);
  info.append(sub);

  const actions = el('div', 'actions');
  if (drifted) {
    actions.append(
      iconButton('Make this page home', 'home', 'secondary', () => send('setHome', { id: pin.id })),
      iconButton('Back to home', 'reset', 'reset', () => send('reset', { id: pin.id })),
    );
  }
  actions.append(
    iconButton('Add to Favorites', 'star', 'secondary', () => send('place', { id: pin.id, place: { favorite: true } })),
    iconButton('Unpin', 'close', 'secondary', () => send('unpin', { id: pin.id })),
  );

  li.append(favicon(drifted ? tab.url : pin.homeUrl), info, actions);
  li.addEventListener('click', () => send('open', { id: pin.id }));
  li.addEventListener('keydown', (e) => { if (e.key === 'Enter') send('open', { id: pin.id }); });
  li.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, pinMenuItems(pin, tab, folders));
  });
  return li;
}

function renderFolder(folder, folderPins, tabsById, activeTabId, folders) {
  const wrap = el('div', 'folder');
  wrap.dataset.folderId = folder.id;
  wrap.classList.toggle('open', !folder.collapsed);

  const head = el('div', 'folder-head');
  head.dataset.folderId = folder.id;
  head.tabIndex = 0;
  const chev = el('span', 'chev');
  chev.append(icon('chevron'));
  const folderIcon = el('span', 'row-icon');
  folderIcon.append(icon('folder'));
  const name = el('span', 'folder-name');

  if (editingFolderId === folder.id) {
    const input = el('input');
    input.value = folder.name;
    input.setAttribute('aria-label', 'Folder name');
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      editingFolderId = null;
      if (save && input.value.trim() && input.value.trim() !== folder.name) {
        await send('renameFolder', { id: folder.id, name: input.value });
      }
      scheduleRender();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
      e.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
    name.append(input);
    queueMicrotask(() => { input.focus(); input.select(); });
  } else {
    name.textContent = folder.name;
  }

  const actions = el('div', 'actions');
  actions.append(
    iconButton('Rename folder', 'pencil', 'secondary', () => startRename(folder.id)),
    iconButton('Delete folder (keeps its tabs)', 'close', 'secondary', () => send('deleteFolder', { id: folder.id })),
  );

  head.append(chev, folderIcon, name, el('span', 'folder-count', String(folderPins.length)), actions);
  head.addEventListener('click', () => send('toggleFolder', { id: folder.id }));
  head.addEventListener('keydown', (e) => { if (e.key === 'Enter') send('toggleFolder', { id: folder.id }); });
  head.addEventListener('dblclick', (e) => { e.preventDefault(); startRename(folder.id); });
  head.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, [
      { text: folder.collapsed ? 'Expand' : 'Collapse', action: () => send('toggleFolder', { id: folder.id }) },
      { text: 'Rename', action: () => startRename(folder.id) },
      '-',
      { text: 'Delete folder (keeps its tabs)', danger: true, action: () => send('deleteFolder', { id: folder.id }) },
    ]);
  });
  wrap.append(head);

  if (!folder.collapsed) {
    const body = el('ul', 'rows folder-body');
    body.dataset.folderId = folder.id;
    if (folderPins.length === 0) body.append(el('li', 'hint', 'Drag pinned tabs here'));
    for (const pin of folderPins) {
      body.append(renderPinRow(pin, tabsById.get(pin.tabId) || null, activeTabId, folders));
    }
    wrap.append(body);
  }
  return wrap;
}

function renderTabRow(tab, activeTabId) {
  const li = el('li', 'row tab');
  li.dataset.tabId = tab.id;
  li.draggable = true;
  li.tabIndex = 0;
  li.classList.toggle('active', tab.id === activeTabId);

  const img = el('img', 'favicon');
  img.alt = '';
  // Chrome's local favicon cache: no network requests from the panel.
  img.src = faviconUrl(tab.url || tab.pendingUrl || '');
  img.addEventListener('error', () => {
    const fallback = el('span', 'row-icon');
    fallback.append(icon('globe'));
    img.replaceWith(fallback);
  }, { once: true });

  const info = el('div', 'info');
  info.append(el('span', 'title', tab.title || tab.url || 'New tab'));

  const actions = el('div', 'actions');
  if (isPinnable(tab.url)) {
    actions.append(iconButton('Pin tab', 'pin', 'secondary', () => send('pinTab', { tabId: tab.id })));
  }
  actions.append(iconButton('Close tab', 'close', 'secondary', () => chrome.tabs.remove(tab.id)));

  li.append(img, info, actions);
  li.addEventListener('click', () => chrome.tabs.update(tab.id, { active: true }));
  li.addEventListener('keydown', (e) => { if (e.key === 'Enter') chrome.tabs.update(tab.id, { active: true }); });
  li.addEventListener('auxclick', (e) => { if (e.button === 1) chrome.tabs.remove(tab.id); });
  li.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const items = [];
    if (isPinnable(tab.url)) {
      items.push(
        { text: 'Pin tab', action: () => send('pinTab', { tabId: tab.id }) },
        { text: 'Add to Favorites', action: () => send('pinTab', { tabId: tab.id, place: { favorite: true } }) },
        '-',
      );
    }
    items.push({ text: 'Close tab', danger: true, action: () => chrome.tabs.remove(tab.id) });
    showMenu(e.clientX, e.clientY, items);
  });
  return li;
}

async function render() {
  const [{ pins, folders }, tabs] = await Promise.all([
    getState(),
    chrome.tabs.query({}),
  ]);
  const tabsById = new Map(tabs.map((t) => [t.id, t]));
  const activeTabId = tabs.find((t) => t.active && t.windowId === windowId)?.id;
  const linkedTabIds = new Set(pins.map((p) => p.tabId).filter((id) => tabsById.has(id)));

  // Favorites grid
  const favs = pins.filter((p) => p.favorite);
  favoritesEl.classList.toggle('empty', favs.length === 0);
  favoritesEl.replaceChildren(...(favs.length
    ? favs.map((p) => renderFavorite(p, tabsById.get(p.tabId) || null, activeTabId, folders))
    : [document.createTextNode('Drag a tab here or click ★ to add a favorite')]));

  // Pinned: folders first, then loose pins
  const folderIds = new Set(folders.map((f) => f.id));
  const loose = pins.filter((p) => !p.favorite && !folderIds.has(p.folderId));
  const pinnedChildren = folders.map((f) => renderFolder(
    f, pins.filter((p) => !p.favorite && p.folderId === f.id), tabsById, activeTabId, folders));
  const looseList = el('ul', 'rows loose');
  looseList.append(...loose.map((p) => renderPinRow(p, tabsById.get(p.tabId) || null, activeTabId, folders)));
  pinnedChildren.push(looseList);
  if (pins.filter((p) => !p.favorite).length === 0 && folders.length === 0) {
    pinnedChildren.push(el('div', 'hint', 'Pin tabs you use often. They remember their home page.'));
  }
  pinnedEl.replaceChildren(...pinnedChildren);

  // Today: this window's open tabs that aren't linked to a pin
  const today = tabs
    .filter((t) => t.windowId === windowId && !linkedTabIds.has(t.id))
    .sort((a, b) => a.index - b.index);
  todayEl.replaceChildren(...today.map((t) => renderTabRow(t, activeTabId)));
}

// Coalesce bursts of events into one render, and never re-render mid-drag or
// while a folder name is being typed (it would wipe the input).
function scheduleRender() {
  if (pendingRender) return;
  pendingRender = true;
  setTimeout(() => {
    pendingRender = false;
    if (dragging || editingFolderId && document.activeElement?.tagName === 'INPUT') return;
    render().catch(console.error);
  }, 50);
}

function startRename(folderId) {
  editingFolderId = folderId;
  render().catch(console.error);
}

// ---------- drag and drop ----------

function clearDropMarks() {
  document.querySelectorAll('.drop-before, .drop-after, .drop-into')
    .forEach((n) => n.classList.remove('drop-before', 'drop-after', 'drop-into'));
}

/** Work out what dropping at this point would do. */
function resolveDrop(e) {
  const t = e.target instanceof Element ? e.target : e.target.parentElement;
  if (!t) return null;

  const fav = t.closest('.fav');
  if (fav) {
    const r = fav.getBoundingClientRect();
    const position = e.clientX < r.left + r.width / 2 ? 'before' : 'after';
    return { mark: fav, cls: `drop-${position}`, place: { favorite: true, anchorId: fav.dataset.pinId, position } };
  }
  if (t.closest('#favorites')) {
    return { mark: favoritesEl, cls: 'drop-into', place: { favorite: true } };
  }

  const pinRow = t.closest('.row.pin');
  if (pinRow) {
    const r = pinRow.getBoundingClientRect();
    const position = e.clientY < r.top + r.height / 2 ? 'before' : 'after';
    return {
      mark: pinRow,
      cls: `drop-${position}`,
      place: { folderId: pinRow.dataset.folderId || null, anchorId: pinRow.dataset.pinId, position },
    };
  }
  const folderTarget = t.closest('.folder-head, .folder-body');
  if (folderTarget) {
    const folderEl = folderTarget.closest('.folder');
    return { mark: folderEl, cls: 'drop-into', place: { folderId: folderEl.dataset.folderId } };
  }
  if (t.closest('#pinned-section')) {
    return { mark: pinnedEl, cls: 'drop-into', place: {} };
  }

  if (t.closest('#today-section')) {
    if (dragging.kind === 'pin') {
      return { mark: todayEl, cls: 'drop-into', unpin: true };
    }
    const tabRow = t.closest('.row.tab');
    if (tabRow && tabRow.dataset.tabId !== String(dragging.id)) {
      const r = tabRow.getBoundingClientRect();
      const position = e.clientY < r.top + r.height / 2 ? 'before' : 'after';
      return { mark: tabRow, cls: `drop-${position}`, moveTab: { targetTabId: Number(tabRow.dataset.tabId), position } };
    }
  }
  return null;
}

document.addEventListener('dragstart', (e) => {
  const item = e.target.closest?.('.fav, .row.pin, .row.tab');
  if (!item) return;
  hideMenu();
  dragging = item.dataset.pinId
    ? { kind: 'pin', id: item.dataset.pinId }
    : { kind: 'tab', id: Number(item.dataset.tabId) };
  item.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', '');
});

document.addEventListener('dragend', () => {
  dragging = null;
  clearDropMarks();
  document.querySelectorAll('.dragging').forEach((n) => n.classList.remove('dragging'));
  scheduleRender();
});

document.addEventListener('dragover', (e) => {
  if (!dragging) return;
  const drop = resolveDrop(e);
  clearDropMarks();
  if (!drop) return;
  e.preventDefault();
  drop.mark.classList.add(drop.cls);
});

document.addEventListener('drop', async (e) => {
  if (!dragging) return;
  const drop = resolveDrop(e);
  const item = dragging;
  clearDropMarks();
  if (!drop) return;
  e.preventDefault();

  if (drop.unpin) {
    await send('unpin', { id: item.id });
  } else if (drop.moveTab) {
    await moveTab(item.id, drop.moveTab.targetTabId, drop.moveTab.position);
  } else if (item.kind === 'pin') {
    await send('place', { id: item.id, place: drop.place });
  } else {
    await send('pinTab', { tabId: item.id, place: drop.place });
  }
});

async function moveTab(tabId, targetTabId, position) {
  const [tab, target] = await Promise.all([chrome.tabs.get(tabId), chrome.tabs.get(targetTabId)]);
  let index = target.index + (position === 'after' ? 1 : 0);
  if (tab.windowId === target.windowId && tab.index < target.index) index -= 1;
  await chrome.tabs.move(tabId, { windowId: target.windowId, index });
}

// ---------- wire up ----------

document.getElementById('pin-current').addEventListener('click', () => send('pinActiveTab'));
document.getElementById('new-tab').addEventListener('click', () => chrome.tabs.create({ windowId }));
document.getElementById('new-folder').addEventListener('click', async () => {
  const res = await send('createFolder');
  if (res?.ok) startRename(res.result.id);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.pins || changes.folders)) scheduleRender();
});
for (const event of ['onUpdated', 'onActivated', 'onRemoved', 'onCreated', 'onMoved', 'onAttached', 'onDetached']) {
  chrome.tabs[event].addListener(scheduleRender);
}

(async () => {
  windowId = (await chrome.windows.getCurrent()).id;
  // Fill in the static icon placeholders in the HTML.
  document.querySelectorAll('[data-icon]').forEach((n) => n.append(icon(n.dataset.icon)));
  await render();
})();
