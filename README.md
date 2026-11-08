# Homebase

**Arc-style pinned tabs for Chrome.** Pinned tabs that remember their *home* URL. Click around as much as you like, then send the tab back home in one click.

Arc is winding down, and this is the Arc feature I missed most, so I rebuilt it for Chrome.

<img src="docs/panel.png" width="360" alt="Homebase side panel">

## Features

- **Home URL per pinned tab.** Pin a tab, and Homebase remembers where it started.
- **Drift detection.** When a pinned tab wanders off, the side panel shows where it is now ("Away: …").
- **One-click reset.** Hit ↺ (or `Alt+Shift+H`) to go straight back home.
- **Pins outlive their tabs.** Close a pinned tab and the pin stays. Click it to reopen at home.
- **Make this the new home.** Found a better starting page? Hit ⌂ to make it home.
- **Drag to reorder.** Order your pins the way you like.
- **Survives restarts.** Pins re-attach to your restored tabs when Chrome starts.
- **Private by design.** Everything is stored locally in your browser. No accounts, no servers, no tracking.

## Install (developer mode)

1. Clone or download this repo.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the project folder.
4. Pin the Homebase icon to your toolbar and click it to open the side panel.

Requires Chrome 116 or later.

## Usage

| Action | How |
| --- | --- |
| Pin the current tab | **+ Pin tab** in the panel, right-click a page → *Pin to Homebase*, or `Alt+Shift+P` |
| Go to a pinned tab | Click it in the panel (reopens it if it was closed) |
| Back to home | ↺ in the panel, or `Alt+Shift+H` on the tab |
| Make the current page home | ⌂ (shown on hover when a tab has drifted) |
| Unpin | × (shown on hover) |
| Reorder | Drag and drop |

You can change the shortcuts at `chrome://extensions/shortcuts`.

## How it works

```
manifest.json         Manifest V3 config
src/pins.js           Pin state + operations (stored in chrome.storage.local)
src/background.js     Service worker: tab events, shortcuts, context menu, messages
sidepanel/            The side panel UI (plain HTML/CSS/JS, no build step)
```

- The **service worker** owns all writes and runs them one at a time through a small promise queue, so tab events and panel clicks can't overwrite each other.
- The **side panel** reads state directly and re-renders on storage and tab events.
- Each pin stores the `tabId` it's linked to. Tab IDs change after a browser restart, so on startup Homebase re-links pins to restored pinned tabs: exact URL first, then same site.
- Favicons come from Chrome's built-in `_favicon` API, so nothing is fetched from the network.

## Roadmap

- [ ] Auto-archive: close tabs you haven't touched in X hours, with a searchable archive
- [ ] Rename pins
- [ ] Folders / spaces
- [ ] Sync pins across devices (`chrome.storage.sync`)
- [ ] Chrome Web Store release

Ideas and PRs are welcome. Open an issue first for bigger changes.

## License

[MIT](LICENSE)
