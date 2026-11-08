import { getPins, isDrifted } from '../src/pins.js';

const list = document.getElementById('list');
const empty = document.getElementById('empty');
const toast = document.getElementById('toast');

let windowId = null;

// ---------- helpers ----------

async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, windowId, ...payload });
  if (res && !res.ok) showToast(res.error);
  return res;
}

let toastTimer;
function showToast(text) {
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), 2500);
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

function iconButton(label, symbol, className, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.title = label;
  b.setAttribute('aria-label', label);
  b.textContent = symbol;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

// ---------- render ----------

async function render() {
  const [pins, tabs, [activeTab]] = await Promise.all([
    getPins(),
    chrome.tabs.query({}),
    chrome.tabs.query({ active: true, windowId }),
  ]);
  const tabsById = new Map(tabs.map((t) => [t.id, t]));

  empty.hidden = pins.length > 0;
  list.replaceChildren(...pins.map((pin, index) => {
    const tab = tabsById.get(pin.tabId) || null;
    const drifted = isDrifted(pin, tab);

    const li = document.createElement('li');
    li.className = 'pin';
    li.classList.toggle('closed', !tab);
    li.classList.toggle('active', !!tab && tab.id === activeTab?.id);
    li.dataset.id = pin.id;
    li.dataset.index = index;
    li.draggable = true;
    li.tabIndex = 0;
    li.title = `Home: ${pin.homeUrl}`;

    const img = document.createElement('img');
    img.className = 'favicon';
    img.alt = '';
    img.src = faviconUrl(drifted ? tab.url : pin.homeUrl);

    const info = document.createElement('div');
    info.className = 'info';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = pin.title;
    const sub = document.createElement('div');
    sub.className = 'sub';
    if (!tab) {
      sub.textContent = `${hostOf(pin.homeUrl)} · closed`;
    } else if (drifted) {
      sub.classList.add('drift');
      sub.textContent = `Away: ${tab.title || hostOf(tab.url)}`;
    } else {
      sub.textContent = hostOf(pin.homeUrl);
    }
    info.append(title, sub);

    const actions = document.createElement('div');
    actions.className = 'actions';
    if (drifted) {
      actions.append(
        iconButton('Make this page the new home', '⌂', 'secondary', () => send('setHome', { id: pin.id })),
        iconButton('Back to home', '↺', 'reset', () => send('reset', { id: pin.id })),
      );
    }
    actions.append(iconButton('Unpin', '×', 'secondary', () => send('unpin', { id: pin.id })));

    li.append(img, info, actions);
    li.addEventListener('click', () => send('open', { id: pin.id }));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') send('open', { id: pin.id });
    });
    return li;
  }));
}

// Coalesce bursts of tab events into one render.
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => {
    renderQueued = false;
    render().catch(console.error);
  }, 50);
}

// ---------- drag to reorder ----------

let dragId = null;

list.addEventListener('dragstart', (e) => {
  const li = e.target.closest('.pin');
  if (!li) return;
  dragId = li.dataset.id;
  li.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
});

list.addEventListener('dragend', () => {
  dragId = null;
  list.querySelectorAll('.pin').forEach((el) =>
    el.classList.remove('dragging', 'drop-above', 'drop-below'));
});

function dropPosition(e, li) {
  const rect = li.getBoundingClientRect();
  return e.clientY < rect.top + rect.height / 2 ? 'above' : 'below';
}

list.addEventListener('dragover', (e) => {
  const li = e.target.closest('.pin');
  if (!li || !dragId) return;
  e.preventDefault();
  list.querySelectorAll('.pin').forEach((el) => el.classList.remove('drop-above', 'drop-below'));
  li.classList.add(`drop-${dropPosition(e, li)}`);
});

list.addEventListener('drop', (e) => {
  const li = e.target.closest('.pin');
  if (!li || !dragId) return;
  e.preventDefault();
  const fromIndex = [...list.children].findIndex((el) => el.dataset.id === dragId);
  let toIndex = Number(li.dataset.index) + (dropPosition(e, li) === 'below' ? 1 : 0);
  if (fromIndex < toIndex) toIndex -= 1; // account for removal before insert
  send('move', { id: dragId, toIndex });
});

// ---------- wire up ----------

document.getElementById('pin-current').addEventListener('click', () => send('pinActiveTab'));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.pins) scheduleRender();
});
chrome.tabs.onUpdated.addListener(scheduleRender);
chrome.tabs.onActivated.addListener(scheduleRender);
chrome.tabs.onRemoved.addListener(scheduleRender);
chrome.tabs.onCreated.addListener(scheduleRender);

(async () => {
  windowId = (await chrome.windows.getCurrent()).id;
  await render();
})();
