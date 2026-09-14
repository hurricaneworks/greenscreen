import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const ROOT = process.cwd();
const UPLOADS_DIR = path.join(ROOT, "uploads");
const RENDERS_DIR = path.join(ROOT, "renders");
const TEMPLATES_DIR = path.join(ROOT, "public", "templates");

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Rendering shells out to ffmpeg/ffprobe, YouTube capture to yt-dlp. None of them are
// npm dependencies, so check for them once at startup and give a plain message instead
// of a cryptic "spawn ffmpeg ENOENT" the first time someone clicks Render.
const TOOL_INSTALL_HINT = {
  ffmpeg: "macOS: brew install ffmpeg | Windows: winget install ffmpeg | Debian/Ubuntu: sudo apt install ffmpeg",
  ffprobe: "ffprobe ships with ffmpeg; install ffmpeg and it comes too",
  "yt-dlp": "macOS: brew install yt-dlp | Windows: winget install yt-dlp | pip install yt-dlp",
};

function commandExists(cmd) {
  const result = spawnSync(cmd, ["-version"], { stdio: "ignore" });
  return !result.error;
}

const missingTools = new Set();

function missingToolError(cmd) {
  return `${cmd} is not installed or not on your PATH. Install it (${TOOL_INSTALL_HINT[cmd]}), then restart "npm run dev".`;
}

function sanitiseName(name) {
  const base = (name || "upload").split(/[/\\]/).pop() || "upload";
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned || "upload";
}

function safeSegment(name) {
  if (!name || name.includes("/") || name.includes("..") || name.includes("\\")) {
    return null;
  }
  return name;
}

function slugify(name) {
  const trimmed = (name || "").toString().trim().slice(0, 80);
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

function runYtDlp(args, timeoutMs) {
  return new Promise((resolve) => {
    const proc = spawn("yt-dlp", args);
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 200000) {
        stderr = stderr.slice(stderr.length - 200000);
      }
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: timedOut ? -1 : code,
        stderr: timedOut ? "yt-dlp timed out after 5 minutes" : stderr,
      });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stderr: String(err) });
    });
  });
}

// A template's zones can be given as the new `zones: [{x,y,w,h,tStart?,tEnd?}]`
// array, or (legacy) a single `zone: {x,y,w,h}` box — normalize to the array form,
// full-duration window, so every other code path only ever deals with `zones`.
function normalizeZones(template) {
  if (Array.isArray(template.zones) && template.zones.length > 0) {
    return template.zones;
  }
  if (template.zone) {
    return [{ ...template.zone }];
  }
  return [];
}

function getFpsRate(template) {
  if (template.fpsRate) return String(template.fpsRate);
  const fps = typeof template.fps === "number" ? template.fps : 30;
  return String(Math.round(fps));
}

// Template sidecar filenames don't have to match the template's `id` (e.g.
// public/templates/publong.json has id "pub-long") — look up by the `id` field.
function findTemplateById(id) {
  ensureDir(TEMPLATES_DIR);
  const files = fs.readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(TEMPLATES_DIR, f), "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed.id === id) return parsed;
    } catch {
      // skip unreadable/corrupt sidecar
    }
  }
  return null;
}

function uniqueSlugDir(baseSlug) {
  let candidate = baseSlug;
  let n = 1;
  while (fs.existsSync(path.join(RENDERS_DIR, candidate))) {
    n += 1;
    candidate = `${baseSlug}-${n}`;
  }
  return candidate;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 10 * 1024 * 1024) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}

function runFfprobeHasAudio(filePath) {
  return new Promise((resolve) => {
    const args = [
      "-v",
      "error",
      "-select_streams",
      "a",
      "-show_entries",
      "stream=index",
      "-of",
      "csv=p=0",
      filePath,
    ];
    const proc = spawn("ffprobe", args);
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("close", () => {
      resolve(out.trim().length > 0);
    });
    proc.on("error", () => resolve(false));
  });
}

function runFfmpeg(args) {
  return new Promise((resolve) => {
    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 200000) {
        stderr = stderr.slice(stderr.length - 200000);
      }
    });
    proc.on("close", (code) => {
      resolve({ code, stderr });
    });
    proc.on("error", (err) => {
      resolve({ code: -1, stderr: String(err) });
    });
  });
}

function apiMiddlewarePlugin() {
  return {
    name: "meme-maker-api",
    configureServer(server) {
      ensureDir(UPLOADS_DIR);
      ensureDir(RENDERS_DIR);

      for (const cmd of ["ffmpeg", "ffprobe"]) {
        if (!commandExists(cmd)) {
          missingTools.add(cmd);
          server.config.logger.error(`\n  [meme-maker] ${missingToolError(cmd)} Rendering will not work until it is.\n`);
        }
      }
      if (!commandExists("yt-dlp")) {
        missingTools.add("yt-dlp");
        server.config.logger.warn(
          `\n  [meme-maker] yt-dlp not found on PATH. Drag-and-drop still works; YouTube capture will not. (${TOOL_INSTALL_HINT["yt-dlp"]})\n`
        );
      }

      server.middlewares.use(async (req, res, next) => {
        try {
          const url = new URL(req.url, "http://localhost");
          const pathname = url.pathname;

          // GET /api/templates
          if (req.method === "GET" && pathname === "/api/templates") {
            ensureDir(TEMPLATES_DIR);
            const files = fs
              .readdirSync(TEMPLATES_DIR)
              .filter((f) => f.endsWith(".json"));
            const templates = files
              .map((f) => {
                try {
                  const raw = fs.readFileSync(
                    path.join(TEMPLATES_DIR, f),
                    "utf-8"
                  );
                  const parsed = JSON.parse(raw);
                  // Always send `zones` to the client — normalizes legacy single-`zone`
                  // templates so the frontend never has to special-case the old shape.
                  return { ...parsed, zones: normalizeZones(parsed) };
                } catch {
                  return null;
                }
              })
              .filter(Boolean);
            sendJson(res, 200, templates);
            return;
          }

          // POST /api/upload
          if (req.method === "POST" && pathname === "/api/upload") {
            ensureDir(UPLOADS_DIR);
            const rawName = url.searchParams.get("name") || "upload.mp4";
            const safeBase = sanitiseName(rawName);
            const filename = `${Date.now()}-${safeBase}`;
            const dest = path.join(UPLOADS_DIR, filename);

            const MAX_SIZE = 500 * 1024 * 1024;
            let size = 0;
            const writeStream = fs.createWriteStream(dest);
            let aborted = false;

            req.on("data", (chunk) => {
              size += chunk.length;
              if (size > MAX_SIZE && !aborted) {
                aborted = true;
                writeStream.destroy();
                req.destroy();
                try {
                  fs.unlinkSync(dest);
                } catch {
                  // ignore
                }
                sendJson(res, 413, { error: "File too large (max 500MB)" });
              }
            });

            req.on("error", () => {
              writeStream.destroy();
            });

            req.pipe(writeStream);

            writeStream.on("finish", () => {
              if (aborted) return;
              sendJson(res, 200, { id: filename });
            });

            writeStream.on("error", (err) => {
              if (aborted) return;
              sendJson(res, 500, { error: String(err) });
            });
            return;
          }

          // POST /api/youtube
          if (req.method === "POST" && pathname === "/api/youtube") {
            if (missingTools.has("yt-dlp")) {
              sendJson(res, 500, { error: missingToolError("yt-dlp") });
              return;
            }
            let body;
            try {
              body = await readJsonBody(req);
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }

            const { url: ytUrl, start, end } = body || {};

            let parsed;
            try {
              parsed = new URL(ytUrl);
            } catch {
              sendJson(res, 400, { error: "Invalid URL" });
              return;
            }
            if (!YOUTUBE_HOSTS.has(parsed.hostname)) {
              sendJson(res, 400, { error: "URL must be a youtube.com or youtu.be link" });
              return;
            }

            const hasStart = start !== undefined && start !== null;
            const hasEnd = end !== undefined && end !== null;
            if (hasStart !== hasEnd) {
              sendJson(res, 400, { error: "start and end must both be provided or both omitted" });
              return;
            }
            let numStart = null;
            let numEnd = null;
            if (hasStart) {
              numStart = Number(start);
              numEnd = Number(end);
              if (!Number.isFinite(numStart) || !Number.isFinite(numEnd)) {
                sendJson(res, 400, { error: "start/end must be numbers" });
                return;
              }
              if (numStart < 0 || numEnd <= numStart) {
                sendJson(res, 400, { error: "start must be >= 0 and less than end" });
                return;
              }
              if (numEnd - numStart > 600) {
                sendJson(res, 400, { error: "Section must be 600 seconds or less" });
                return;
              }
            }

            ensureDir(UPLOADS_DIR);
            const ts = Date.now();
            const outTemplate = path.join(UPLOADS_DIR, `${ts}-yt.%(ext)s`);
            const titleFile = path.join(UPLOADS_DIR, `${ts}-yt.title.txt`);

            const args = [
              "--no-playlist",
              "-f",
              "bv*[height<=480][ext=mp4]+ba[ext=m4a]/b[height<=480][ext=mp4]/b[height<=480]",
              "--merge-output-format",
              "mp4",
              "-o",
              outTemplate,
              "--print-to-file",
              "%(title)s",
              titleFile,
            ];
            if (hasStart) {
              args.push(
                "--download-sections",
                `*${numStart}-${numEnd}`,
                "--force-keyframes-at-cuts"
              );
            }
            args.push(parsed.toString());

            const result = await runYtDlp(args, 5 * 60 * 1000);
            if (result.code !== 0) {
              try {
                fs.unlinkSync(titleFile);
              } catch {
                // ignore
              }
              const tail = result.stderr.slice(-2000);
              sendJson(res, 500, { error: tail });
              return;
            }

            const producedPath = path.join(UPLOADS_DIR, `${ts}-yt.mp4`);
            if (!fs.existsSync(producedPath)) {
              sendJson(res, 500, { error: "yt-dlp did not produce an mp4 file" });
              return;
            }

            let title = "";
            try {
              title = fs.readFileSync(titleFile, "utf-8").trim();
              fs.unlinkSync(titleFile);
            } catch {
              // non-fatal
            }

            sendJson(res, 200, { id: `${ts}-yt.mp4`, title });
            return;
          }

          // GET /api/upload-file/:id
          if (req.method === "GET" && pathname.startsWith("/api/upload-file/")) {
            const idParam = decodeURIComponent(
              pathname.slice("/api/upload-file/".length)
            );
            const safeId = safeSegment(idParam);
            if (!safeId) {
              sendJson(res, 400, { error: "Invalid id" });
              return;
            }
            const filePath = path.join(UPLOADS_DIR, safeId);
            if (!fs.existsSync(filePath)) {
              sendJson(res, 404, { error: "Not found" });
              return;
            }
            const stat = fs.statSync(filePath);
            res.statusCode = 200;
            res.setHeader("Content-Type", "video/mp4");
            res.setHeader("Content-Length", stat.size);
            fs.createReadStream(filePath).pipe(res);
            return;
          }

          // POST /api/render
          if (req.method === "POST" && pathname === "/api/render") {
            for (const cmd of ["ffmpeg", "ffprobe"]) {
              if (missingTools.has(cmd)) {
                sendJson(res, 500, { error: missingToolError(cmd) });
                return;
              }
            }
            let body;
            try {
              body = await readJsonBody(req);
            } catch (e) {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }

            const {
              uploadId,
              templateId,
              placements: bodyPlacements,
              x,
              y,
              w,
              trimStart,
              delay,
              audioMode,
              name,
              endBehavior,
              templateVolume,
              userVolume,
              tracking,
            } = body || {};

            if (!name || !name.toString().trim()) {
              sendJson(res, 400, { error: "Name required" });
              return;
            }

            const loopMode =
              endBehavior === undefined || endBehavior === null ? "freeze" : endBehavior;
            if (loopMode !== "freeze" && loopMode !== "loop") {
              sendJson(res, 400, { error: "endBehavior must be 'freeze' or 'loop'" });
              return;
            }

            const tmplVol =
              templateVolume === undefined || templateVolume === null
                ? 1
                : Number(templateVolume);
            if (!Number.isFinite(tmplVol) || tmplVol < 0 || tmplVol > 2) {
              sendJson(res, 400, { error: "templateVolume must be between 0 and 2" });
              return;
            }

            const userVol =
              userVolume === undefined || userVolume === null
                ? 1
                : Number(userVolume);
            if (!Number.isFinite(userVol) || userVol < 0 || userVol > 2) {
              sendJson(res, 400, { error: "userVolume must be between 0 and 2" });
              return;
            }

            if (
              tracking !== undefined &&
              tracking !== null &&
              typeof tracking !== "boolean"
            ) {
              sendJson(res, 400, { error: "tracking must be a boolean" });
              return;
            }
            const trackingEnabled = tracking === undefined || tracking === null ? true : tracking;

            const safeUploadId = safeSegment(uploadId);
            if (!safeUploadId) {
              sendJson(res, 400, { error: "Invalid uploadId" });
              return;
            }
            const uploadPath = path.join(UPLOADS_DIR, safeUploadId);
            if (!fs.existsSync(uploadPath)) {
              sendJson(res, 400, { error: "Upload not found" });
              return;
            }

            const safeTemplateId = safeSegment(templateId);
            if (!safeTemplateId) {
              sendJson(res, 400, { error: "Invalid templateId" });
              return;
            }
            const template = findTemplateById(safeTemplateId);
            if (!template) {
              sendJson(res, 400, { error: "Template not found" });
              return;
            }

            const duration =
              typeof template.duration === "number" ? template.duration : 5;
            const templateW = typeof template.width === "number" ? template.width : 640;
            const templateH = typeof template.height === "number" ? template.height : 360;
            const fpsRate = getFpsRate(template);
            const zones = normalizeZones(template);
            if (zones.length === 0) {
              sendJson(res, 500, { error: "Template has no zones defined" });
              return;
            }

            // Back-compat: old clients send flat x/y/w for a single-zone template
            // instead of a `placements` array.
            let placements = Array.isArray(bodyPlacements) ? bodyPlacements : null;
            if (!placements) {
              const flatX = Number(x);
              const flatY = Number(y);
              const flatW = Number(w);
              if (
                zones.length === 1 &&
                Number.isFinite(flatX) &&
                Number.isFinite(flatY) &&
                Number.isFinite(flatW)
              ) {
                placements = [{ x: flatX, y: flatY, w: flatW }];
              } else {
                sendJson(res, 400, {
                  error: `placements array required (expected ${zones.length} entr${
                    zones.length === 1 ? "y" : "ies"
                  })`,
                });
                return;
              }
            }
            if (placements.length !== zones.length) {
              sendJson(res, 400, {
                error: `placements length (${placements.length}) must match template zones (${zones.length})`,
              });
              return;
            }
            const numPlacements = [];
            for (const p of placements) {
              const px = Number(p && p.x);
              const py = Number(p && p.y);
              const pw = Number(p && p.w);
              if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pw)) {
                sendJson(res, 400, { error: "Invalid numeric placement" });
                return;
              }
              if (pw < 16 || pw > 4000) {
                sendJson(res, 400, { error: "placement w must be between 16 and 4000" });
                return;
              }
              numPlacements.push({ x: px, y: py, w: pw });
            }

            const numTrim = Number(trimStart);
            const numDelay = delay === undefined ? 0 : Number(delay);
            if (!Number.isFinite(numTrim) || !Number.isFinite(numDelay)) {
              sendJson(res, 400, { error: "Invalid numeric parameters" });
              return;
            }
            if (numTrim < 0) {
              sendJson(res, 400, { error: "trimStart must be >= 0" });
              return;
            }
            if (numDelay < 0 || numDelay > duration) {
              sendJson(res, 400, {
                error: `delay must be between 0 and ${duration}`,
              });
              return;
            }

            const mode =
              audioMode === "user" || audioMode === "mix"
                ? audioMode
                : "template";

            const templateVideoPath = path.join(
              TEMPLATES_DIR,
              template.video
            );
            if (!fs.existsSync(templateVideoPath)) {
              sendJson(res, 500, { error: "Template video file missing" });
              return;
            }

            const keyColor = template.keyColor || "00FF00";
            const similarity =
              typeof template.similarity === "number"
                ? template.similarity
                : 0.35;
            const blend =
              typeof template.blend === "number" ? template.blend : 0.1;

            ensureDir(RENDERS_DIR);
            const baseSlug = slugify(name);
            const slug = uniqueSlugDir(baseSlug);
            const memeDir = path.join(RENDERS_DIR, slug);
            fs.mkdirSync(memeDir, { recursive: true });
            const outPath = path.join(memeDir, "output.mp4");

            let hasAudio = true;
            if (mode === "user" || mode === "mix") {
              hasAudio = await runFfprobeHasAudio(uploadPath);
            }
            const effectiveMode = mode === "mix" && !hasAudio ? "template" : mode;

            const delayMs = Math.round(numDelay * 1000);
            const zoneCount = zones.length;

            // Screen tracking: for zones that carry track data (from
            // scripts/analyze-template.mjs) and when tracking is on, the overlay's
            // x/y are driven per-frame via ffmpeg sendcmd instead of staying static,
            // so the user's clip moves with the camera pan instead of sitting still
            // under a sliding cutout. Build one sendcmd line per tracked frame,
            // across all tracked zones, sorted by time.
            const trackedZoneIndices = [];
            const cmdEntries = [];
            for (let i = 0; i < zoneCount; i++) {
              const zone = zones[i];
              if (!trackingEnabled || !zone.track || !Array.isArray(zone.track.points)) continue;
              trackedZoneIndices.push(i);
              const p = numPlacements[i];
              for (const point of zone.track.points) {
                const [t, dx, dy] = point;
                cmdEntries.push({
                  t,
                  line: `${t} overlay@z${i} x ${p.x + dx}, overlay@z${i} y ${p.y + dy};`,
                });
              }
            }
            cmdEntries.sort((a, b) => a.t - b.t);

            let cmdFilePath = null;
            if (cmdEntries.length > 0) {
              cmdFilePath = path.join(memeDir, "track.cmd");
              fs.writeFileSync(cmdFilePath, cmdEntries.map((e) => e.line).join("\n") + "\n");
            }

            // One branch of the user video per zone. With a single zone this collapses
            // to exactly the pre-multi-zone graph (no split filter at all).
            let filterComplex = "";
            if (zoneCount > 1) {
              const splitOutputs = Array.from({ length: zoneCount }, (_, i) => `[v${i}]`).join("");
              filterComplex += `[0:v]split=${zoneCount}${splitOutputs};`;
            }
            for (let i = 0; i < zoneCount; i++) {
              const srcLabel = zoneCount > 1 ? `[v${i}]` : `[0:v]`;
              const branchW = numPlacements[i].w;
              filterComplex +=
                loopMode === "loop"
                  ? `${srcLabel}trim=start=${numTrim},scale=${branchW}:-2,setpts=PTS-STARTPTS+${numDelay}/TB[usr${i}];`
                  : `${srcLabel}scale=${branchW}:-2,setpts=PTS-STARTPTS+${numDelay}/TB,tpad=stop_mode=clone:stop=-1[usr${i}];`;
            }

            const bgSendcmd = cmdFilePath ? `,sendcmd=f='${cmdFilePath}'` : "";
            filterComplex += `color=black:size=${templateW}x${templateH}:rate=${fpsRate}${bgSendcmd}[bg0];`;
            let baseLabel = "bg0";
            for (let i = 0; i < zoneCount; i++) {
              const zone = zones[i];
              const tStart = typeof zone.tStart === "number" ? zone.tStart : 0;
              const tEnd = typeof zone.tEnd === "number" ? zone.tEnd : duration;
              const outLabel = i === zoneCount - 1 ? "base" : `base${i}`;
              const p = numPlacements[i];
              const overlayName = trackedZoneIndices.includes(i) ? `overlay@z${i}` : "overlay";
              filterComplex += `[${baseLabel}][usr${i}]${overlayName}=x=${p.x}:y=${p.y}:shortest=0:enable='between(t,${tStart},${tEnd})'[${outLabel}];`;
              baseLabel = outLabel;
            }

            filterComplex +=
              `[1:v]colorkey=0x${keyColor}:${similarity}:${blend}[keyed];` +
              `[base][keyed]overlay=0:0:shortest=1[out]`;

            // In loop mode, user audio needs its own trim/retime (no -ss on the input,
            // since -stream_loop + -ss don't compose reliably). audioFilterInput is the
            // filtergraph label carrying the (possibly re-timed) user audio.
            const needsUserAudio =
              (effectiveMode === "user" || effectiveMode === "mix") && hasAudio;
            let audioFilterInput = "[0:a]";
            if (loopMode === "loop" && needsUserAudio) {
              filterComplex += `;[0:a]atrim=start=${numTrim},asetpts=PTS-STARTPTS[ua0]`;
              audioFilterInput = "[ua0]";
            }
            if (needsUserAudio && userVol !== 1) {
              filterComplex += `;${audioFilterInput}volume=${userVol}[uvol]`;
              audioFilterInput = "[uvol]";
            }

            // Template (crowd) audio label, with optional volume adjustment. Only
            // appended in branches that consume it — an unconsumed filter output
            // would make ffmpeg fail.
            const wantsTemplateAudio =
              effectiveMode === "template" || effectiveMode === "mix";
            let templateAudioLabel = "[1:a]";
            if (wantsTemplateAudio && tmplVol !== 1) {
              filterComplex += `;[1:a]volume=${tmplVol}[ta]`;
              templateAudioLabel = "[ta]";
            }

            const mapArgs = [];
            if (effectiveMode === "template") {
              mapArgs.push("-map", "[out]", "-map", templateAudioLabel === "[ta]" ? "[ta]" : "1:a");
            } else if (effectiveMode === "user") {
              if (hasAudio) {
                if (delayMs > 0) {
                  filterComplex += `;${audioFilterInput}adelay=${delayMs}:all=1[ua]`;
                  mapArgs.push("-map", "[out]", "-map", "[ua]");
                } else if (audioFilterInput !== "[0:a]") {
                  // Loop-retimed and/or volume-adjusted user audio lives in a
                  // filtergraph label rather than the raw input stream.
                  mapArgs.push("-map", "[out]", "-map", audioFilterInput);
                } else {
                  mapArgs.push("-map", "[out]", "-map", "0:a");
                }
              } else {
                mapArgs.push("-map", "[out]");
              }
            } else {
              // mix (hasAudio guaranteed true here, else effectiveMode fell back to template)
              if (delayMs > 0) {
                filterComplex += `;${audioFilterInput}adelay=${delayMs}:all=1[ua];[ua]${templateAudioLabel}amix=inputs=2:duration=first[aout]`;
              } else {
                filterComplex += `;${audioFilterInput}${templateAudioLabel}amix=inputs=2:duration=first[aout]`;
              }
              mapArgs.push("-map", "[out]", "-map", "[aout]");
            }

            const inputArgs =
              loopMode === "loop"
                ? ["-stream_loop", "-1", "-i", uploadPath]
                : ["-ss", String(numTrim), "-i", uploadPath];

            const args = [
              "-y",
              ...inputArgs,
              "-i",
              templateVideoPath,
              "-filter_complex",
              filterComplex,
              ...mapArgs,
              "-t",
              String(duration),
              "-c:v",
              "libx264",
              "-preset",
              "veryfast",
              "-crf",
              "20",
              "-pix_fmt",
              "yuv420p",
              "-c:a",
              "aac",
              "-movflags",
              "+faststart",
              outPath,
            ];

            const result = await runFfmpeg(args);
            if (result.code !== 0) {
              const tail = result.stderr.slice(-2000);
              try {
                // Removes the whole meme dir, including track.cmd if one was written.
                fs.rmSync(memeDir, { recursive: true, force: true });
              } catch {
                // ignore cleanup failure
              }
              sendJson(res, 500, { error: tail });
              return;
            }

            if (cmdFilePath) {
              try {
                fs.unlinkSync(cmdFilePath);
              } catch {
                // non-fatal: the render itself succeeded, cmd file is scratch anyway
              }
            }

            const uploadExt = path.extname(safeUploadId) || ".mp4";
            const sourceFile = `source${uploadExt}`;
            try {
              fs.copyFileSync(uploadPath, path.join(memeDir, sourceFile));
            } catch {
              // non-fatal: the render itself succeeded
            }

            const displayName = name.toString().trim().slice(0, 80);
            const meme = {
              name: displayName,
              slug,
              templateId: safeTemplateId,
              params: {
                placements: numPlacements,
                trimStart: numTrim,
                delay: numDelay,
                audioMode: mode,
                endBehavior: loopMode,
                templateVolume: tmplVol,
                userVolume: userVol,
                tracking: trackingEnabled,
              },
              createdAt: new Date().toISOString(),
              sourceFile,
            };
            try {
              fs.writeFileSync(
                path.join(memeDir, "meme.json"),
                JSON.stringify(meme, null, 2)
              );
            } catch {
              // non-fatal: the render itself succeeded
            }

            sendJson(res, 200, {
              url: `/api/file/${slug}/output.mp4`,
              name: `${slug}.mp4`,
              slug,
            });
            return;
          }

          // GET /api/memes
          if (req.method === "GET" && pathname === "/api/memes") {
            ensureDir(RENDERS_DIR);
            const entries = fs
              .readdirSync(RENDERS_DIR, { withFileTypes: true })
              .filter((e) => e.isDirectory());
            const memes = entries
              .map((e) => {
                try {
                  const raw = fs.readFileSync(
                    path.join(RENDERS_DIR, e.name, "meme.json"),
                    "utf-8"
                  );
                  return JSON.parse(raw);
                } catch {
                  return null;
                }
              })
              .filter(Boolean)
              .sort((a, b) => {
                const ta = Date.parse(a.createdAt) || 0;
                const tb = Date.parse(b.createdAt) || 0;
                return tb - ta;
              });
            sendJson(res, 200, memes);
            return;
          }

          // DELETE /api/memes/:slug
          if (req.method === "DELETE" && pathname.startsWith("/api/memes/")) {
            const slugParam = decodeURIComponent(
              pathname.slice("/api/memes/".length)
            );
            const safeSlug = safeSegment(slugParam);
            if (!safeSlug) {
              sendJson(res, 400, { error: "Invalid slug" });
              return;
            }
            const dir = path.join(RENDERS_DIR, safeSlug);
            if (!fs.existsSync(dir)) {
              sendJson(res, 404, { error: "Not found" });
              return;
            }
            try {
              fs.rmSync(dir, { recursive: true, force: true });
            } catch (err) {
              sendJson(res, 500, { error: String(err) });
              return;
            }
            sendJson(res, 200, { ok: true });
            return;
          }

          // GET /api/file/<slug>/<file>  (and legacy /api/file/<name>.mp4)
          if (req.method === "GET" && pathname.startsWith("/api/file/")) {
            const rest = decodeURIComponent(pathname.slice("/api/file/".length));
            const segments = rest.split("/").filter(Boolean);

            let filePath;
            if (segments.length === 1) {
              // Legacy flat render file: renders/<name>.mp4
              const safeName = safeSegment(segments[0]);
              if (!safeName) {
                sendJson(res, 400, { error: "Invalid file name" });
                return;
              }
              filePath = path.join(RENDERS_DIR, safeName);
            } else if (segments.length === 2) {
              const safeSlug = safeSegment(segments[0]);
              const safeFile = safeSegment(segments[1]);
              if (!safeSlug || !safeFile) {
                sendJson(res, 400, { error: "Invalid file path" });
                return;
              }
              filePath = path.join(RENDERS_DIR, safeSlug, safeFile);
            } else {
              sendJson(res, 400, { error: "Invalid file path" });
              return;
            }

            if (!fs.existsSync(filePath)) {
              sendJson(res, 404, { error: "Not found" });
              return;
            }
            const stat = fs.statSync(filePath);
            const ext = path.extname(filePath).toLowerCase();
            const contentType =
              ext === ".json"
                ? "application/json"
                : ext === ".mp4"
                ? "video/mp4"
                : "application/octet-stream";
            res.statusCode = 200;
            res.setHeader("Content-Type", contentType);
            res.setHeader("Content-Length", stat.size);
            fs.createReadStream(filePath).pipe(res);
            return;
          }

          next();
        } catch (err) {
          sendJson(res, 500, { error: String(err && err.stack ? err.stack : err) });
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), apiMiddlewarePlugin()],
  server: {
    port: 4050,
  },
});
