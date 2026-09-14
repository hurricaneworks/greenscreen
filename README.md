# Green Screen Meme Maker

Put any video clip on the TV screens in a cheering pub crowd, and render it as an mp4.

Drop in a clip (or grab one from YouTube), drag it into position on the green screen, trim it,
choose whose audio plays, and click Render. The output lands in a "My memes" library you can
replay, download, re-edit and delete. Everything runs on your own machine. No accounts, no
uploads to anyone's server, no cloud.

It ships with two templates: a five-second single-screen pub celebration, and a longer
two-screen version where the camera pans from a big screen to a small one. The screens are
motion-tracked, so your clip stays glued to the TV as the camera moves. Adding your own
template is documented below.

## Requirements

| Tool | Why | Install |
|---|---|---|
| Node.js 22 or newer | runs the app | [nodejs.org](https://nodejs.org) |
| ffmpeg (includes ffprobe) | renders the video | macOS `brew install ffmpeg` · Windows `winget install ffmpeg` · Debian/Ubuntu `sudo apt install ffmpeg` |
| yt-dlp (optional) | YouTube capture | macOS `brew install yt-dlp` · Windows `winget install yt-dlp` · anywhere `pip install yt-dlp` |

Check with `ffmpeg -version` and `yt-dlp --version`. If ffmpeg is missing the app still starts
and tells you so in the terminal, but Render will fail with a message saying what to install.
Without yt-dlp, drag-and-drop works and only the YouTube box is dead.

## Quick start

```bash
git clone https://github.com/hurricaneworks/greenscreen.git
cd greenscreen
npm ci
npm run dev
```

Open http://localhost:4050. That is the whole install.

`npm run dev` is not a "development mode" you later swap for something else. The app *is* the
Vite dev server: a plugin in `vite.config.ts` adds the API routes that upload, render and serve
files. There is no build step to deploy and nothing else to run.

## Using Claude Code or another AI coding assistant

This repo is set up to be worked on with an AI assistant. `CLAUDE.md` is the assistant's
operating manual: the stack, every file, how the ffmpeg filtergraph is built, and a list of
gotchas. Claude Code reads it automatically when you open the folder. Other tools (Cursor,
Copilot, Codex) can be pointed at it.

If you have never run a Node project before, this works:

1. Install Node.js and ffmpeg from the table above.
2. Open a terminal in this folder and start your assistant (for Claude Code, type `claude`).
3. Ask it: *"Read the README and CLAUDE.md, then get the app running and open it in my browser."*

Good first requests once it runs:

- "Add a new template from this video file." It will follow the template workflow below.
- "Change the default end behaviour to loop."
- "Explain how the preview canvas matches the ffmpeg render."

The assistant does not need to touch ffmpeg by hand. Everything it needs is in `vite.config.ts`
and `scripts/analyze-template.mjs`.

## Using the app

1. **Pick a template** in the left sidebar.
2. **Add your clip**: drag a video onto the canvas, or paste a YouTube URL (optionally with a
   start and end time) into the YouTube box.
3. **Position it.** The clip auto-fits to the screen. Drag to move, use the scale slider to
   resize. On the two-screen template, click a screen (or use the Screen 1 / Screen 2 chips) to
   choose which one you are editing.
4. **Trim and time it.** Set where the clip starts, and an optional delay before it first
   appears. Choose what happens if the clip is shorter than the template: freeze on the last
   frame, or loop.
5. **Audio**: template only, your clip only, or a mix with separate volumes.
6. **Name it and Render.** Renders need a name; it becomes the folder under `renders/`.

Rendered memes show up in "My memes". Edit reloads the original clip and every setting, and
re-rendering under the same name makes a new sibling (`name-2`, `name-3`) rather than
overwriting.

## Adding your own template

A template is an mp4 plus a JSON sidecar in `public/templates/`. The video needs one or more
solid green (`#00FF00`) screens. Actual chroma green works best; a screenshot with a green
rectangle painted on it works too.

1. Drop `mytemplate.mp4` into `public/templates/`.
2. Write `public/templates/mytemplate.json`. Copy `pub.json` and change:
   - `id`, `name`, `video`, `width`, `height`, `fps`, `fpsRate`, `duration` (ffprobe tells
     you these).
   - `zones`: one entry per green screen, with the bounding box `x, y, w, h` that contains the
     screen at *every* frame it is visible, and optional `tStart` / `tEnd` in seconds if it is
     only on camera for part of the clip. Delete any `track` field you copied; step 3 rebuilds it.
   - `keyColor`, `similarity`, `blend` only if your green does not key cleanly.
3. Run `node scripts/analyze-template.mjs mytemplate`. This motion-tracks each screen and writes
   the tracking data back into the sidecar. Re-run it whenever you change a zone.
4. Restart `npm run dev`. The template appears in the sidebar.

Rules of thumb: two zones may overlap in space as long as they are not on screen at the same
time. Panning shots are fine (that is what tracking is for); a screen that zooms a lot will not
look perfect because the zone box is a fixed rectangle. `CLAUDE.md` has the full detail.

## Keep it on localhost

The API behind this app writes files to disk and launches ffmpeg and yt-dlp on request. It has
no authentication. That is fine while it only answers on `localhost`, which is Vite's default.

**Never start it with `--host`, `server.host: true`, or behind a port forward.** Anyone who can
reach the port can fill your disk, run downloads, and delete your meme library. If you want to
share the tool, share the repo, not your running copy.

## YouTube capture

The YouTube box hands the URL to `yt-dlp`, capped at 480p and at ten minutes when a start and
end time are given. Only youtube.com and youtu.be hostnames are accepted. Whether you may
download and reuse a given video is between you, the uploader and YouTube's terms. The tool
does not check.

## Windows notes

The dev script is plain `vite --port 4050`, so it works in cmd, PowerShell and Git Bash.

`.npmrc` sets `node-options=--max-http-header-size=65536`. npm applies it on every platform, so
you do not need to set it yourself. It exists because browsers send *all* `localhost` cookies to
every port, and if you run many local apps the header can exceed Node's default 16 KB and every
request fails with HTTP 431. If you use bun or pnpm instead of npm and hit a 431, set
`NODE_OPTIONS=--max-http-header-size=65536` in your shell, or clear your localhost cookies.

## Troubleshooting

- **"ffmpeg is not installed or not on your PATH"** when rendering: install ffmpeg (table above),
  open a new terminal so PATH refreshes, restart `npm run dev`.
- **Port 4050 already in use**: change the port in `vite.config.ts` (`server.port`) and in the
  `dev` script in `package.json`.
- **Green still visible around the edges of the screen**: raise `similarity` or `blend` a little
  in the template's JSON. Check with a clip that contains no green of its own first, or you will
  be chasing your own footage.
- **Clip slides off the screen during a pan**: run `analyze-template.mjs` for that template and
  make sure tracking is on.
- **Everything 404s in the browser but the terminal looks fine**: you probably have two dev
  servers running. Stop them all and start one.

## Project layout

```
vite.config.ts               API middleware (upload, YouTube, render, memes, file serving) + Vite config
src/                         React UI
scripts/analyze-template.mjs motion-tracks a template's green screens
public/templates/            template mp4s and JSON sidecars
uploads/                     raw clips (created on demand, gitignored)
renders/<slug>/              one folder per meme: output.mp4, source clip, meme.json (gitignored)
```

## Licence

MIT. See `LICENSE`. The two bundled pub templates are included under the same licence.
