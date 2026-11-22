# Smooth Zoom to Cursor

> Trackpad-style smooth zoom to the cursor with Ctrl+Mouse Wheel.  
> Compositor-driven CSS transitions keep it smooth even on heavy pages. Crisp when idle, preserves fixed elements. Native Ctrl + / - zoom remains untouched.

**Author:** diple_df x claude

## Demo

![Smooth Zoom around the cursor](docs/zoom.gif)

The pointer rests on the word "anchored" the whole time. The page grows around it and the word
stays under the pointer, then everything returns to 100% with the original scroll position.
Recorded in a live session: one Ctrl+wheel gesture in and out, no scrolling, no re-anchoring.

## Installation

### Step 1 — Install a Userscript Manager

The script requires a browser extension to run. Supported managers:

| Extension | Chrome | Firefox | Edge |
|---|---|---|---|
| **Tampermonkey** (recommended) | ✓ | ✓ | ✓ |
| Violentmonkey | ✓ | ✓ | ✓ |
| Greasemonkey | — | ✓ | — |

Install the extension from your browser's official add-on store.

### Step 2 — Install the Script

**Option A — 1-click install (recommended):**

1. Click the automatic install link: **[Install Smooth Zoom to Cursor](https://raw.githubusercontent.com/diple-df/Smooth-Zoom/main/smooth-zoom.user.js)**
2. Tampermonkey will automatically intercept the file and open the installation prompt
3. Click **Install**

**Option B — manually:**

1. Copy the contents of `smooth-zoom.user.js`
2. Open Tampermonkey → **Create a new script**
3. Paste the code and press **Save** (`Ctrl+S`)

### Step 3 — Use It

Hold **Ctrl** and scroll the mouse wheel to smoothly zoom in/out to the cursor position. Scroll normally while zoomed in to pan around. Release/zoom out to return to normal view.

## Features

- **Smooth zoom to cursor** — Zoom is anchored to your mouse position, just like trackpad pinch-to-zoom
- **GPU-accelerated transitions** — Uses CSS transforms with compositor-driven animations for silky smoothness
- **Works on heavy pages** — Stays responsive even on complex sites
- **Preserves fixed elements** — Fixed elements keep their exact screen position and size at any zoom level
- **Native zoom intact** — Ctrl + / - keyboard zoom is not affected
- **Smart panning** — When zoomed in, mouse wheel scrolls the zoomed viewport
- **Auto-return** — Zooms back to normal when scale returns to 1

## How It Works

The script applies `transform: translate() scale()` to the document root with smooth CSS transitions and handles panning by adjusting the transform offset.

`position: fixed` elements do not follow an ancestor transform for their layout offset but they do obey `zoom`, so each one is pinned with `zoom: 1/scale` and repositioned as `left = target - tx`. That keeps headers, modals and floating buttons exactly where they were instead of stretching with the page, and the element's own `transform` (`translate(-50%, -50%)` centring, `scale`, rotate animations) is never overwritten.

Elements whose containing block is not the viewport — a `fixed` node inside an ancestor with `transform`, `filter`, `contain` or `will-change` — are deliberately left alone, because they already scale together with that ancestor. Compensating them used to throw them up to ~780 px off screen.

`position: sticky` is intentionally not compensated: it lives in the normal flow and must grow with the page like any other content.

## Technical Details

### Granted Permissions

The script uses two kinds of Tampermonkey storage/API grants: `GM_setValue` /
`GM_getValue` for settings, and `GM_xmlhttpRequest` (locked to
`raw.githubusercontent.com` / `github.com` via `@connect`) for the update check.
No other network access happens.

### Auto-update

Two layers, both pointing at the same raw file in this repository:

1. **Passive** — `@updateURL` / `@downloadURL` in the header. Tampermonkey
   checks them on its own schedule and offers the update.
2. **Active** — the script reads the remote `@version` itself:
   - once per day, in the background, after the page has loaded (idle callback,
     never during a zoom);
   - on demand from the Tampermonkey menu: **Smooth Zoom: Проверить обновления**.

   When the remote version is newer, a small banner appears in the corner with
   a link to the raw script. The banner is shown once per version; a manual
   check always shows the result, including "Установлена последняя версия".

Versions are compared field by field, so `2.10.0` correctly counts as newer than
`2.9.0` (a plain string comparison would get this wrong). The check costs one
`localStorage` read on start-up; the network is touched at most once a day.

### Settings

Key parameters can be adjusted in the script:
- `minScale`: 1 (minimum zoom)
- `maxScale`: 10 (maximum zoom)
- `wheelStep`: 0.0015 (zoom sensitivity)
- `panSpeed`: 1 (wheel pan speed while zoomed)
- `transitionMs`: 120 (zoom smoothing duration)
- `crispDelayMs`: 200 (pause before the page is re-rasterized sharp)
- `shiftWheelHorizontal`: false (Shift+wheel pans horizontally)

### Performance

At most one `transform` write per animation frame, and effectively no work while
idle: no animation loop, no timers, no layout reads in input handlers, and
`will-change` is dropped as soon as the zoom settles. Measured in headless Edge:
zero animation-frame requests during a one-second idle window.

### Known limitations

- At the very edge of a page the cursor anchor is bounded by the pan limits
  (otherwise empty space would appear); this matches native page zoom.
- `position: sticky` elements behave as static during zoom, because native
  scrolling is pinned to 0 for the duration.
- Pages that already apply `transform` or CSS `zoom` to `<html>` are left
  untouched so the script cannot corrupt their layout.
- Wheel input over a nested scrollable element pans the zoomed page, not that
  element.

