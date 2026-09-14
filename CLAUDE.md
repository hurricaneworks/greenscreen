# Green Screen Meme Maker

A local-only tool that composites a user's video clip onto the green TV screens in a template
video and renders the result with ffmpeg. Two templates ship with it; users add their own.
Everything runs on the user's machine from `npm run dev`. There is no deployment target, no
auth, and no cloud: keep it that way (see "Keep it on localhost" in `README.md`).

Read `README.md` first for the user-facing picture. This file is the engineering manual.

## Stack
- Vite + React + TypeScript (plain CSS, no Tailwind/UI kit).
- No separate backend: a custom Vite plugin (`vite.config.ts`) adds dev-server middleware for
  `/api/templates`, `/api/upload`, `/api/upload-file/:id`, `/api/youtube`, `/api/render`,
  `/api/memes`, `/api/file/:slug/:file`. Rendering shells out to `ffmpeg`/`ffprobe` on PATH via
  `child_process.spawn` (no Express/multer). YouTube capture shells out to `yt-dlp` the same way.
- None of ffmpeg, ffprobe or yt-dlp are npm dependencies. `configureServer` checks for them at
  startup, logs a plain message if any is missing, and `/api/render` / `/api/youtube` return that
  same message as a 500 instead of a `spawn ENOENT`.

## Commands
```bash
npm ci           # install from the lockfile
npm run dev      # the app, on http://localhost:4050
npm run build    # tsc --noEmit + vite build (type-check and bundle check only; nothing is deployed)
node scripts/analyze-template.mjs <templateId>   # (re)build screen-tracking data for a template
```
`.npmrc` sets `node-options=--max-http-header-size=65536` so the dev script stays a plain
cross-platform `vite --port 4050`; see the Windows notes in `README.md` for why.

## File Structure
- `vite.config.ts` — the API middleware plugin (templates/upload/render/memes/file serving) plus Vite config.
- `public/templates/pub.mp4` + `public/templates/pub.json` — the built-in single-screen "Pub Crowd Celebration" template (mp4 + metadata sidecar). Still uses the legacy singular `zone` field (kept deliberately, to exercise the back-compat path) rather than `zones`.
- `public/templates/publong.mp4` + `public/templates/publong.json` — "Pub Crowd (long, two screens)", id `pub-long`. Two green screens that are never on-screen at the same time (a big one t=0–14.0s, a small one t=13.9s–end); uses the `zones` array with per-zone `tStart`/`tEnd`. Note the sidecar filename doesn't match the id (`publong.json` vs id `pub-long`) — templates are looked up by their `id` field, not by filename.
- The single-screen template mp4 exists only under `public/templates/`; there is no separate original in the project root.
- `src/App.tsx` — top-level state (template selection, user video source, per-zone placements/scale, trim, delay, end-behaviour, audio mode, render lifecycle, meme library).
- `src/components/TemplateGallery.tsx`, `PreviewCanvas.tsx`, `Controls.tsx`, `RenderResult.tsx`, `TrimScrubber.tsx`, `MemeLibrary.tsx`, `YouTubeCapture.tsx`, `ZoneChips.tsx` — UI pieces. Layout: the left `<aside className="sidebar">` in `App.tsx` renders `TemplateGallery` then `MemeLibrary` stacked (both render bare `sidebar-section` content, no own `<aside>`/card wrapper); `ZoneChips` and `TrimScrubber` are rendered *inside* `Controls.tsx` (Position and Timing sections respectively) — `App.tsx` just passes the refs/values down.
- `src/types.ts` — shared `Template` / `TemplateZone` / `ZoneTrack` / `RenderParams` / `Placement` / `Meme` / `UserSource` types.
- `scripts/analyze-template.mjs` — motion-tracks each zone's green screen and writes `zones[i].track` into a template's sidecar JSON (see "Screen tracking" below). Run it once whenever a template's zones change.
- `uploads/` — gitignored scratch dir for raw uploads (drag-drop and YouTube captures), created on demand.
- `renders/<slug>/` — one folder per rendered meme: `output.mp4`, `source.<ext>` (copy of the upload, so the meme is re-editable), `meme.json` (name/slug/templateId/params/createdAt/sourceFile), and a transient `track.cmd` (ffmpeg sendcmd file) that exists only *during* a tracked render and is deleted before the response comes back. Whole `renders/` dir is gitignored.

## How rendering works
A template video has one or more solid-green (`0x00FF00`) TV screens, each with its own bounding
box (`zone`) and, for multi-screen templates, a time window (`tStart`/`tEnd`) during which that
particular screen is on camera. The single user clip is split into one branch per zone
(`[0:v]split=N[v0][v1]...`); each branch gets its own `scale=<placement.w>:-2` + trim/setpts (+
`tpad` in freeze mode, or `trim`/`stream_loop` in loop mode) and is drawn onto a `template.width x
template.height` black canvas at that zone's placement, gated by
`overlay=...:enable='between(t,tStart,tEnd)'` — so a zone only draws while the template clock is
inside its window. A single-zone template collapses to a graph with no `split` filter at all
(this is the regression-safety property for the single-screen template). The keyed template video
(green made transparent via `colorkey`) is then laid on top of all the zone overlays, so the
user's clip only shows through wherever a screen currently is. A `delay` param (default 0)
offsets when the user clip starts appearing in ANY zone, via `setpts=PTS-STARTPTS+delay/TB` on
each branch and `adelay` on the user audio in `user`/`mix` modes. `PreviewCanvas.tsx` mirrors
this exactly: one `<video>` element for the user's clip, drawn once per zone only when the
template's current time falls inside that zone's window (and past `delay`), with the same
per-pixel green-transparency rule for the keyed template layer on top. The canvas coordinate
space always comes from `template.width`/`template.height` — nothing is hardcoded to 640x360.

Multi-zone editing: `RenderParams`/`meme.json` carry a `placements: {x,y,w}[]` array, index-aligned
with the template's `zones` array (one placement per zone; height is always derived from the clip's
own aspect ratio via `scale=w:-2`). Clicking inside a zone's on-canvas rect selects it
(topmost/highest-index zone wins on overlap); the scale slider and drag-to-move only affect the
selected zone. A "Screen 1 / Screen 2" chip row (`ZoneChips.tsx`) shows and lets you switch the
selection — hidden entirely for single-zone templates. Auto-fit fits only the selected zone to its
own bbox; loading a fresh clip auto-fits every zone at once.

Screen tracking: without it, the user's clip sits still while the keyed cutout slides over it as
the camera pans — looks wrong. `scripts/analyze-template.mjs <templateId>` fixes this by
motion-tracking each zone's green screen and writing the result into that zone as
`track: { fps, ref: [cx0, cy0], points: [[t, dx, dy], ...] }` — `dx`/`dy` are the green-pixel
centroid's drift at time `t` relative to the zone's first tracked frame (so the first point is
always `[t0, 0, 0]`). It works by decoding the template through
`colorkey=...,format=rgba,alphaextract,format=gray` at half resolution (green pixels come out
< 64), sampling every 2nd row/col for speed, and averaging the coordinates of matched pixels that
fall inside that zone's bbox expanded 25% (so a neighbouring zone's screen can't pollute the
centroid) and inside its `[tStart, tEnd)` window. It's idempotent — re-running only replaces the
`track` field(s); a template still on the legacy singular `zone` field gets promoted to a
one-element `zones` array the first time (same normalization the server does at request time),
after which its `tStart`/`tEnd`/etc. are preserved across further runs. Run it whenever you touch
a template's zones: `node scripts/analyze-template.mjs pub` / `node scripts/analyze-template.mjs pub-long`.

At render time, `POST /api/render`'s `tracking` param (boolean, default true) controls whether
track data is used at all. For each zone that both has `track` data and is being tracked, its
overlay gets a named instance (`overlay@z0`, `overlay@z1`, ...) instead of the plain `overlay`
filter, and a `track.cmd` sendcmd file is generated with one line per tracked frame across all
tracked zones (sorted by time): `<t> overlay@zN x <placement.x + dx>, overlay@zN y <placement.y +
dy>;`. That file is attached once, on the `color=black:...` background source
(`,sendcmd=f='<path>'`), and is deleted after the render finishes — on success explicitly, on
failure implicitly (the whole `renders/<slug>/` dir gets removed on a failed render anyway). Zones
without track data — or any zone at all when `tracking:false` — fall back to the static
`overlay=x=...:y=...` form; a template with zero tracked zones produces the plain untracked
filtergraph. `PreviewCanvas.tsx` mirrors this: it looks up each zone's `(dx, dy)` at the current
template time (linear interpolation between neighbouring track points, clamped before the first /
after the last), draws that zone's copy offset by it, and — when dragging a tracked zone — solves
for the *base* placement by subtracting the current offset from the desired on-screen position, so
the clip stays under the cursor.

Back-compat, both directions: a template with an old singular `zone` field (no `zones` array) is
normalized server-side into `zones: [{...zone, no time window}]` before being sent to the client
or used in a render — `GET /api/templates` always returns `zones`, never bare `zone`, to keep the
frontend's `Template` type simple. Symmetrically, `POST /api/render` accepts old flat `x`/`y`/`w`
(no `placements`) as long as the target template has exactly one zone, treating it as
`placements: [{x,y,w}]`; multi-zone templates require an explicit `placements` array. Old
`meme.json` files (flat `x`/`y`/`w`, no `placements`) are still read fine by `/api/memes`, and the
frontend's Edit flow converts them into a one-entry `placements` array on the fly.

Renders must be named: POST `/api/render` rejects a missing/blank `name` with 400 ("Name
required"). The name is slugified, de-duplicated with `-2`, `-3`, ... suffixes, and everything is
written into `renders/<slug>/`. The "My memes" panel lists `renders/*/meme.json` (newest first)
and can play/download/edit/delete each one — Edit re-fetches the stored source clip as a fresh
upload and restores its saved params (including end-behaviour), so re-rendering under the same
name creates a new sibling slug rather than overwriting.

End-behaviour (`endBehavior`: `"freeze"` default or `"loop"`) controls what happens once the
user's clip runs out before the template does. Freeze uses `tpad` to clone the last frame. Loop
instead feeds ffmpeg `-stream_loop -1` on the upload (no `-ss`, since seek and stream-loop don't
compose reliably) and moves the trim into the filtergraph (`trim=start=<trimStart>` /
`atrim=start=<trimStart>`) — semantically, the *first* pass plays from `trimStart` to the end of
the clip, and every subsequent loop plays the *whole* clip from 0. The live preview mimics this
with the same "first pass vs. wrapped" formula so what you see matches the render.

YouTube capture (`POST /api/youtube`, hostname-allowlisted to youtube.com/youtu.be domains)
shells out to `yt-dlp`, capped at 480p and, when a start/end section is given, at 600 seconds —
the fetched clip lands in `uploads/` and is fed into the exact same editor flow as a drag-dropped
file. `GET /api/upload-file/:id` lets the frontend pull that server-side upload back down as a
blob without going through `/api/upload` again.

## Security model
The API has no auth and can write to disk, spawn ffmpeg/yt-dlp, and delete render folders. It
is safe only because Vite binds to `localhost`. Never add `--host` / `server.host: true`, and
never port a feature in a way that assumes a remote caller. Path parameters (`uploadId`, meme
slug, file name) go through `safeSegment`, which rejects `/`, `\` and `..`; keep that on any new
endpoint that touches the filesystem.

## Gotchas
- Chroma-key tuning (`keyColor`, `similarity`, `blend`) lives per-template in its JSON
  sidecar, not hardcoded in the render code — tweak there if a new template's green
  isn't keying cleanly.
- `uploads/` and `renders/` are gitignored scratch dirs; safe to delete anytime, the app
  recreates them (deleting `renders/` wipes the meme library's history).
- `/api/file/<slug>/<file>` serves per-meme assets (`output.mp4`, `source.*`, `meme.json`);
  a single-segment `/api/file/<name>.mp4` is still accepted for backwards compatibility with
  any pre-library flat render files.
- Template mp4s live in `public/templates/` with a matching JSON sidecar (see `pub.json` for
  the shape). To add a new template: drop the mp4 in, write the sidecar JSON including a
  precomputed zone bounding box per screen (the union of where the green screen appears across
  its whole window), then run `analyze-template.mjs` for it — the frontend uses the zone to
  auto-fit the user's video so it covers the screen in every frame.
- YouTube capture needs `yt-dlp` on PATH; it isn't an npm dependency, so `npm ci` will not
  bring it in.
- The user-video source is tracked as `{kind:"local", file}` or `{kind:"server", uploadId}`
  (see `UserSource` in `src/types.ts`) — a YouTube-fetched clip already lives in `uploads/`,
  so Render skips `POST /api/upload` and reuses that `uploadId` directly; only local
  drag-dropped/edited files go through the upload step.
- Older `renders/*/meme.json` files may lack `endBehavior` — treat it as `"freeze"` when
  reading (the frontend's edit-restore does `meme.params.endBehavior ?? "freeze"`).
- **Adding a new template (analysis workflow):** find every green-screen instance in the source
  video and, for each, work out its union bounding box (the box that contains the screen at every
  frame it's visible — e.g. sample frames across a pan with `ffmpeg -vf colorkey=...,cropdetect`
  or just eyeball frame grabs at regular intervals) and its visible time window
  (`tStart`/`tEnd` — omit both for "the whole clip"). Write one `zones[]` entry per screen. If two
  screens' union boxes overlap in time, they must be genuinely simultaneous on screen (rare) —
  the current renderer draws zones in array order with later zones on top, it does not solve
  occlusion between simultaneously-visible zones.
- **Zone bbox = the window's outer bound, not a moving mask.** A zone's `x/y/w/h` is one fixed
  rectangle for its entire `[tStart, tEnd)` window — the `track` data (see "Screen tracking" above)
  moves the user's *clip* to follow the screen's centroid, but it does not reshape or resize the
  overlay to trace the screen's exact silhouette frame-by-frame, and the zone bbox itself must
  still be big enough to contain the screen at every moment in its window (this is what
  `analyze-template.mjs`'s union-bbox-of-the-window step is for). A shot where the screen changes
  size a lot (zooming, not just panning) won't look perfect even with tracking on.
- Without tracking, a panning shot always looks wrong (clip static, cutout sliding over it)
  unless its window is kept very tight. Run `analyze-template.mjs` and tracking fixes that for any
  zone it can find green pixels in; a zone with no green pixels found in its window (rare — e.g. a
  screen that's only ever a sliver at the very edge of frame) just has no `track` and silently
  falls back to the static behaviour for that zone only.
- **Chroma-key false positive when testing:** ffmpeg's `testsrc2` synthetic pattern contains a
  pure `(0,255,0)` swatch in its color bars — using it as a "does the screen get fully covered"
  smoke-test source can make an *already-covered* zone look like it still has leftover green
  (the green you're seeing is the user clip's own content, not an un-keyed screen). Use a
  green-free source (e.g. `color=c=blue` or `color=c=red`) for that specific check.
