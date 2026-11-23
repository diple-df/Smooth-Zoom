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

### Sticky headers
Sticky headers (the chip bar above a search result list, a sticky table header) are
deliberately **not** compensated. They live in normal flow, so under the zoom they scale
with the content around them and slide off the edges the same way ordinary text does.
Pinning them by a one-axis offset was tried and measured: the header returned to its
screen position but its width grew 1193 -> 1960 px at 164%, so it visibly jumped on every
wheel step. A partially compensated element is worse than a consistent one, so sticky is
left alone.

### Elements that appear mid-zoom

A dialog, toast or dropdown that the page creates *while* you are already zoomed used to land off
screen: measured on a page zoomed to 1.39, a centred modal opened at `-251, -157` px, entirely
outside the viewport. Its target position was being read from the already-transformed box. The target
now comes from the element's layout coordinates, which do not depend on the zoom, so a modal opened at
any scale appears where the page intended. Elements that existed before the zoom are unaffected —
both numbers are identical for them.

### Web components and shadow DOM

Sites built with custom elements keep their fixed headers, toasts and side panels inside a shadow root. `getElementsByTagName` does not descend into a shadow root, so those elements used to be skipped and simply scaled away with the page — measured drift of `-412, -257` px at 164%.

The scan now walks every reachable open shadow root up to six levels deep and compensates those elements exactly like ordinary ones. Closed shadow roots stay invisible to any script and are skipped.

### Fixed elements that stretch instead of staying put

A fixed element stretched by `left`/`right` has no intrinsic width. Clearing `right` used to leave width on `auto`, so the browser collapsed the element to its content — a full-width header measured `1265 → 224` px. Width is now pinned in pixels for every compensated element.

### Absolute overlays pinned to the viewport

Not every overlay is `position:fixed`. Dialogs, modal masks, side panels and toasts are often plain `position:absolute` elements with no positioned ancestor, which makes the viewport their containing block. Under the page transform they scaled with the document: measured on DuckDuckGo, a full-screen mask grew from 1280×800 to 2103×1315 and slid to −411,−257, and a right-edge panel moved off-screen entirely.

Such an element is now detected (no positioned ancestor, and it either covers most of the viewport, touches one of its edges, or is centred in it) and compensated the same way as a fixed one. Elements that only look similar — decorative boxes positioned relative to an article — keep their parent and scale with the content, because the check requires the containing block to actually be the viewport.

Measured on a fixture with four overlays at 164%: mask, side panel, centred modal and an off-screen tooltip all end at `dl = dt = dw = dh = 0`, while the article around them scales by 1.643 as it should.

### Scroll lock

While zoomed, the root element gets `overflow: hidden` and `scrollbar-gutter: stable`. Without that, the enlarged transform box adds area to the root's scrollable overflow. On sites that set `overflow: auto` on `<html>` — DuckDuckGo, for one — this spawns a horizontal scrollbar, which takes 15 px off `clientWidth`, which fires `resize`, which relayouts the page, which removes the scrollbar again. The result was visible flicker and content sliding off to the left. Reserving the scrollbar gutter keeps the viewport width identical before and after the zoom, so nothing reflows and the cursor anchor stays exact. Both properties are restored on zoom-out.

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

