# Smooth Zoom to Cursor

> Trackpad-style smooth zoom to the cursor with Ctrl+Mouse Wheel.  
> Compositor-driven CSS transitions keep it smooth even on heavy pages. Crisp when idle, preserves fixed elements. Native Ctrl + / - zoom remains untouched.

**Author:** diple_df x claude

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
- **Preserves fixed elements** — Fixed/sticky elements are handled correctly during zoom
- **Native zoom intact** — Ctrl + / - keyboard zoom is not affected
- **Smart panning** — When zoomed in, mouse wheel scrolls the zoomed viewport
- **Auto-return** — Zooms back to normal when scale returns to 1

## How It Works

The script applies `transform: translate() scale()` to the document root with smooth CSS transitions, converts fixed-position elements to absolute positioning during zoom to prevent rendering issues, and handles panning by adjusting the transform offset.

## Technical Details

### Granted Permissions

This script uses `@grant none` — no special Tampermonkey permissions required.

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
`will-change` is dropped as soon as the zoom settles. See [PERF.md](PERF.md) for
the full workload model and the list of handled edge cases.

### Known limitations

- At the very edge of a page the cursor anchor is bounded by the pan limits
  (otherwise empty space would appear); this matches native page zoom.
- `position: sticky` elements behave as static during zoom, because native
  scrolling is pinned to 0 for the duration.
- Pages that already apply `transform` or CSS `zoom` to `<html>` are left
  untouched so the script cannot corrupt their layout.
- Wheel input over a nested scrollable element pans the zoomed page, not that
  element.

