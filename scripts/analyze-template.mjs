#!/usr/bin/env node
// Motion-tracks the green screen(s) in a template video and writes the result
// into that template's sidecar JSON as zones[i].track.
//
// Usage: node scripts/analyze-template.mjs <templateId>
//
// For each zone (with its [tStart,tEnd) time window), samples the chroma-key
// mask frame by frame, computes the green-pixel centroid inside that zone's
// bbox (expanded 25% so a neighbouring zone's screen can't pollute it), and
// stores the centroid's drift over time relative to the zone's first tracked
// frame. The server (vite.config.ts) uses this via ffmpeg sendcmd to move the
// user's clip in lock-step with the camera pan instead of leaving it static
// under a sliding cutout.
//
// Idempotent: re-running replaces each zone's track (and, for a template that
// still uses the legacy singular `zone` field, promotes it into a one-element
// `zones` array so the track has somewhere to live — everything else in the
// sidecar is left untouched).

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TEMPLATES_DIR = path.join(ROOT, "public", "templates");

function findSidecar(templateId) {
  const files = fs.readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    const full = path.join(TEMPLATES_DIR, f);
    try {
      const parsed = JSON.parse(fs.readFileSync(full, "utf-8"));
      if (parsed.id === templateId) return { file: full, data: parsed };
    } catch {
      // skip unreadable/corrupt sidecar
    }
  }
  return null;
}

// Same normalization the server does at request time, except here we persist
// the result back into the sidecar (creating `zones` from a legacy `zone` the
// first time; on subsequent runs `zones` already exists and is reused as-is
// so any hand-edited tStart/tEnd/etc. survive).
function normalizeZones(template) {
  if (Array.isArray(template.zones) && template.zones.length > 0) {
    return template.zones.map((z) => ({ ...z }));
  }
  if (template.zone) {
    return [{ ...template.zone }];
  }
  return [];
}

function parseFpsRate(template) {
  if (template.fpsRate) {
    const [num, den] = String(template.fpsRate).split("/").map(Number);
    if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) return num / den;
  }
  return typeof template.fps === "number" ? template.fps : 30;
}

function runFfmpegRaw(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args);
    const chunks = [];
    let stderr = "";
    proc.stdout.on("data", (d) => chunks.push(d));
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-2000)}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    proc.on("error", reject);
  });
}

function expandBox(zone, factor) {
  const dw = zone.w * (factor - 1);
  const dh = zone.h * (factor - 1);
  return {
    x: zone.x - dw / 2,
    y: zone.y - dh / 2,
    w: zone.w + dw,
    h: zone.h + dh,
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

async function main() {
  const templateId = process.argv[2];
  if (!templateId) {
    console.error("Usage: node scripts/analyze-template.mjs <templateId>");
    process.exit(1);
  }

  const found = findSidecar(templateId);
  if (!found) {
    console.error(`No sidecar found with id "${templateId}" in ${TEMPLATES_DIR}`);
    process.exit(1);
  }
  const { file: sidecarPath, data: template } = found;

  const videoPath = path.join(TEMPLATES_DIR, template.video);
  if (!fs.existsSync(videoPath)) {
    console.error(`Template video missing: ${videoPath}`);
    process.exit(1);
  }

  const keyColor = template.keyColor || "00FF00";
  const similarity = typeof template.similarity === "number" ? template.similarity : 0.35;
  const fullW = template.width;
  const fullH = template.height;
  const halfW = Math.round(fullW / 2);
  const halfH = Math.round(fullH / 2);
  const fps = parseFpsRate(template);
  const frameDuration = 1 / fps;
  const duration = typeof template.duration === "number" ? template.duration : 5;

  const zones = normalizeZones(template);
  if (zones.length === 0) {
    console.error(`Template "${templateId}" has no zones (and no legacy zone) to track.`);
    process.exit(1);
  }

  console.log(
    `Analyzing "${templateId}" (${template.video}): ${zones.length} zone(s), ${fullW}x${fullH} @ ${fps.toFixed(3)}fps, mask at ${halfW}x${halfH}`
  );

  const args = [
    "-i",
    videoPath,
    "-an",
    "-vf",
    `colorkey=0x${keyColor}:${similarity}:0.05,format=rgba,alphaextract,format=gray,scale=${halfW}:${halfH}`,
    "-f",
    "rawvideo",
    "-",
  ];
  const raw = await runFfmpegRaw(args);

  const frameSize = halfW * halfH;
  const frameCount = Math.floor(raw.length / frameSize);
  console.log(`Decoded ${frameCount} mask frames (${raw.length} bytes, ${frameSize} bytes/frame)`);

  // Per zone: accumulate [t, cx, cy] for every frame that has a valid centroid
  // inside that zone's expanded bbox and time window.
  const zoneCentroids = zones.map(() => []);
  const expandedBoxes = zones.map((z) => expandBox(z, 1.25));

  for (let frame = 0; frame < frameCount; frame++) {
    const t = frame * frameDuration;
    const base = frame * frameSize;

    for (let zi = 0; zi < zones.length; zi++) {
      const zone = zones[zi];
      const tStart = typeof zone.tStart === "number" ? zone.tStart : 0;
      const tEnd = typeof zone.tEnd === "number" ? zone.tEnd : duration;
      if (t < tStart || t >= tEnd) continue;

      const box = expandedBoxes[zi];
      let sumX = 0;
      let sumY = 0;
      let count = 0;

      // Sample every 2nd row/col of the half-res mask for speed.
      for (let y = 0; y < halfH; y += 2) {
        const rowOffset = base + y * halfW;
        const fullY = y * 2;
        if (fullY < box.y || fullY >= box.y + box.h) continue;
        for (let x = 0; x < halfW; x += 2) {
          const fullX = x * 2;
          if (fullX < box.x || fullX >= box.x + box.w) continue;
          if (raw[rowOffset + x] < 64) {
            sumX += fullX;
            sumY += fullY;
            count++;
          }
        }
      }

      if (count > 0) {
        zoneCentroids[zi].push({ t, cx: sumX / count, cy: sumY / count });
      }
    }
  }

  zones.forEach((zone, zi) => {
    const centroids = zoneCentroids[zi];
    if (centroids.length === 0) {
      console.log(`  Zone ${zi}: no green pixels found in its time window — skipping track.`);
      delete zone.track;
      return;
    }
    const ref = centroids[0];
    const points = centroids.map((c) => [
      Math.round(c.t * 10000) / 10000,
      round1(c.cx - ref.cx),
      round1(c.cy - ref.cy),
    ]);
    zone.track = {
      fps,
      ref: [round1(ref.cx), round1(ref.cy)],
      points,
    };
    const last = points[points.length - 1];
    console.log(
      `  Zone ${zi}: ${points.length} tracked frames, ref=(${zone.track.ref[0]}, ${zone.track.ref[1]}), final drift=(${last[1]}, ${last[2]})`
    );
  });

  template.zones = zones;
  fs.writeFileSync(sidecarPath, JSON.stringify(template, null, 2) + "\n");
  console.log(`Wrote track data into ${sidecarPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
