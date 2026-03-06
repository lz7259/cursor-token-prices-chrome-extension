# Cursor Token Prices Browser Extension

Shows the actual API costs on the Cursor Usage page – even when included in your current plan. Costs appear as inline text in the usage table and update automatically when day filters are applied.

<img width="976" height="661" alt="image" src="https://github.com/user-attachments/assets/e104ff3c-989a-4e73-b608-28515aa8c71d" />

## How it works

`inject.js` runs at `document_start` in the page's own JavaScript context (Manifest V3 `"world": "MAIN"`) and patches `fetch` and `XMLHttpRequest` before any page scripts load. Every call to the Cursor usage API is intercepted, parsed, and forwarded to `content.js` via a `CustomEvent`. On each new response (initial load or filter change) the existing cost annotations are removed and re-rendered from scratch.

Current support:

- Chrome / Chromium-based browsers
- Firefox 128+ for local temporary installation

## Installation

### Chrome / Chromium

1. Clone this repo
2. `chrome://extensions/` → enable **Developer mode** → **Load unpacked** → select the project folder
3. Open [cursor.com/dashboard?tab=usage](https://cursor.com/dashboard?tab=usage)

After code changes: reload on `chrome://extensions/` (Reload), then `Cmd+Shift+R` / `Ctrl+Shift+R` on the usage page.

### Firefox

1. Use Firefox 128 or newer
2. Open `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on**
4. Select this project's `manifest.json`
5. Open [cursor.com/dashboard?tab=usage](https://cursor.com/dashboard?tab=usage)

After code changes: click **Reload** for the temporary add-on in `about:debugging`, then `Cmd+Shift+R` / `Ctrl+Shift+R` on the usage page.

## Debugging

```javascript
// In DevTools Console on the usage page:
window.__cursorUsageData;
```

## License

MIT
