import * as pins from './pins.js';

// Run every state change one after another so two events can't overwrite
// each other's writes to storage.
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

// Clicking the toolbar icon opens the side panel.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(console.error);

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'pin-page',
      title: 'Pin to Homebase',
      contexts: ['page'],
    });
  });
  serial(() => pins.relinkTabs({ fresh: false }));
});

chrome.runtime.onStartup.addListener(() => {
  serial(() => pins.relinkTabs({ fresh: true }));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  serial(() => pins.forgetTab(tabId));
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  serial(() => pins.replaceTab(addedTabId, removedTabId));
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'pin-page') {
    serial(() => pins.pinTab(tab)).catch(console.warn);
  }
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (!tab) return;
  if (command === 'pin-current-tab') {
    serial(() => pins.pinTab(tab)).catch(console.warn);
  } else if (command === 'reset-current-tab') {
    serial(async () => {
      const pin = await pins.findPinByTabId(tab.id);
      if (pin) await pins.resetPin(pin.id, tab.windowId);
    }).catch(console.warn);
  }
});

// Messages from the side panel.
const handlers = {
  async pinActiveTab({ windowId }) {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    return pins.pinTab(tab);
  },
  async pinTab({ tabId, place }) {
    return pins.pinTab(await chrome.tabs.get(tabId), place);
  },
  place: ({ id, place }) => pins.placePin(id, place),
  open: ({ id, windowId }) => pins.openPin(id, windowId),
  reset: ({ id, windowId }) => pins.resetPin(id, windowId),
  setHome: ({ id }) => pins.setHomeToCurrent(id),
  unpin: ({ id }) => pins.unpin(id),
  createFolder: ({ name }) => pins.createFolder(name),
  renameFolder: ({ id, name }) => pins.renameFolder(id, name),
  toggleFolder: ({ id }) => pins.toggleFolder(id),
  deleteFolder: ({ id }) => pins.deleteFolder(id),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  serial(() => handler(msg)).then(
    (result) => sendResponse({ ok: true, result }),
    (err) => sendResponse({ ok: false, error: err.message }),
  );
  return true; // respond asynchronously
});
