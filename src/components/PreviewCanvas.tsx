import { useEffect, useRef } from "react";
import type { AudioMode, EndBehavior, Template, ZoneTrack } from "../types";

export interface ZonePlacement {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Props {
  template: Template;
  userVideoUrl: string | null;
  placements: ZonePlacement[];
  selectedZoneIndex: number;
  onSelectZone: (index: number) => void;
  onPositionChange: (index: number, x: number, y: number) => void;
  trimStart: number;
  delay: number;
  audioMode: AudioMode;
  endBehavior: EndBehavior;
  tracking: boolean;
  playing: boolean;
  showZone: boolean;
  templateVideoRef: React.RefObject<HTMLVideoElement | null>;
  userVideoRef: React.RefObject<HTMLVideoElement | null>;
}

// Linear interpolation of a zone's tracked (dx, dy) drift at time t; clamps to
// the first/last tracked point outside the tracked range.
function getTrackOffset(track: ZoneTrack, t: number): { dx: number; dy: number } {
  const points = track.points;
  if (!points || points.length === 0) return { dx: 0, dy: 0 };
  if (t <= points[0][0]) return { dx: points[0][1], dy: points[0][2] };
  const last = points[points.length - 1];
  if (t >= last[0]) return { dx: last[1], dy: last[2] };

  let lo = 0;
  let hi = points.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] <= t) lo = mid;
    else hi = mid;
  }
  const [t0, dx0, dy0] = points[lo];
  const [t1, dx1, dy1] = points[hi];
  if (t1 === t0) return { dx: dx0, dy: dy0 };
  const frac = (t - t0) / (t1 - t0);
  return { dx: dx0 + (dx1 - dx0) * frac, dy: dy0 + (dy1 - dy0) * frac };
}

export default function PreviewCanvas({
  template,
  userVideoUrl,
  placements,
  selectedZoneIndex,
  onSelectZone,
  onPositionChange,
  trimStart,
  delay,
  audioMode,
  endBehavior,
  tracking,
  playing,
  showZone,
  templateVideoRef,
  userVideoRef,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  const dragState = useRef<{
    dragging: boolean;
    zoneIndex: number;
    startClientX: number;
    startClientY: number;
    startX: number;
    startY: number;
  } | null>(null);
  const rafRef = useRef<number | null>(null);

  const canvasW = template.width;
  const canvasH = template.height;

  // Keep latest position/size in a ref so the draw loop always reads current values
  const propsRef = useRef({
    placements,
    selectedZoneIndex,
    trimStart,
    delay,
    audioMode,
    endBehavior,
    tracking,
    playing,
    showZone,
  });
  propsRef.current = {
    placements,
    selectedZoneIndex,
    trimStart,
    delay,
    audioMode,
    endBehavior,
    tracking,
    playing,
    showZone,
  };

  // Screen-tracking offset for zone `i` at template time `t` — zero unless
  // tracking is on and that zone has track data.
  const getZoneOffset = (zoneIndex: number, t: number): { dx: number; dy: number } => {
    if (!propsRef.current.tracking) return { dx: 0, dy: 0 };
    const zone = template.zones[zoneIndex];
    if (!zone || !zone.track) return { dx: 0, dy: 0 };
    return getTrackOffset(zone.track, t);
  };

  // (Re)create the offscreen keying canvas whenever the template's canvas size changes
  useEffect(() => {
    const off = document.createElement("canvas");
    off.width = canvasW;
    off.height = canvasH;
    offscreenRef.current = off;
  }, [canvasW, canvasH]);

  // Play / pause the template (master clock)
  useEffect(() => {
    const tv = templateVideoRef.current;
    if (!tv) return;
    if (playing) {
      tv.play().catch(() => {});
    } else {
      tv.pause();
    }
  }, [playing, templateVideoRef]);

  // Play / pause the user video alongside, respecting freeze-at-end behaviour
  useEffect(() => {
    const uv = userVideoRef.current;
    if (!uv) return;
    if (!playing) {
      uv.pause();
    }
  }, [playing, userVideoRef, userVideoUrl]);

  // Mute rules based on audio mode (template video only — the user video's mute
  // also depends on the delay window, so it's set every frame in the draw loop)
  useEffect(() => {
    const tv = templateVideoRef.current;
    if (tv) tv.muted = !(audioMode === "template" || audioMode === "mix");
  }, [audioMode, templateVideoRef]);

  // Loop the template video manually on ended
  useEffect(() => {
    const tv = templateVideoRef.current;
    if (!tv) return;
    const onEnded = () => {
      tv.currentTime = 0;
      if (propsRef.current.playing) tv.play().catch(() => {});
    };
    tv.addEventListener("ended", onEnded);
    return () => tv.removeEventListener("ended", onEnded);
  }, [templateVideoRef]);

  // In "loop" end-behaviour, restart the user clip from 0 when it naturally ends
  // (the per-frame resync also wraps it, but this covers native end-of-playback).
  useEffect(() => {
    const uv = userVideoRef.current;
    if (!uv) return;
    const onEnded = () => {
      if (propsRef.current.endBehavior !== "loop") return;
      uv.currentTime = 0;
      if (propsRef.current.playing) uv.play().catch(() => {});
    };
    uv.addEventListener("ended", onEnded);
    return () => uv.removeEventListener("ended", onEnded);
  }, [userVideoRef, userVideoUrl]);

  // Draw loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const tick = () => {
      const tv = templateVideoRef.current;
      const uv = userVideoRef.current;
      const { placements, trimStart, delay, audioMode, endBehavior, playing } =
        propsRef.current;

      const templateTime = tv ? tv.currentTime : 0;
      const beforeDelay = templateTime < delay;

      // Sync the single user video element to the template's master clock, offset
      // by delay. Same clip, same clock, no matter how many zones draw it.
      if (uv && tv && uv.readyState >= 1 && Number.isFinite(uv.duration) && uv.duration > 0) {
        if (beforeDelay) {
          // Not entered yet: hold at trimStart, paused, force-muted.
          if (!uv.paused) uv.pause();
          if (Math.abs(uv.currentTime - trimStart) > 0.08) {
            uv.currentTime = Math.max(trimStart, 0);
          }
          uv.muted = true;
        } else if (endBehavior === "loop") {
          // e = user-clip elapsed time since entering; first pass plays trimStart→end,
          // subsequent passes loop the whole clip 0→end.
          const e = templateTime - delay;
          const firstPass = Math.max(uv.duration - trimStart, 0);
          const desired = e < firstPass ? trimStart + e : (e - firstPass) % uv.duration;
          if (uv.paused && playing) {
            uv.play().catch(() => {});
          }
          if (Math.abs(uv.currentTime - desired) > 0.08) {
            uv.currentTime = Math.max(desired, 0);
          }
          uv.muted = !(audioMode === "user" || audioMode === "mix");
        } else {
          const desired = templateTime - delay + trimStart;
          const clampedDesired = Math.min(desired, Math.max(uv.duration - 0.03, 0));
          if (desired >= uv.duration) {
            if (!uv.paused) uv.pause();
            if (Math.abs(uv.currentTime - clampedDesired) > 0.08) {
              uv.currentTime = clampedDesired;
            }
          } else {
            if (uv.paused && playing) {
              uv.play().catch(() => {});
            }
            if (Math.abs(uv.currentTime - desired) > 0.08) {
              uv.currentTime = Math.max(desired, 0);
            }
          }
          uv.muted = !(audioMode === "user" || audioMode === "mix");
        }
      }

      // Background
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvasW, canvasH);

      // User video, once per zone — only drawn while the template clock is inside
      // that zone's [tStart, tEnd) window (and past the global delay). When
      // tracking, the copy is shifted by that zone's (dx,dy) at the current time
      // so it moves with the camera pan instead of sitting still under the cutout.
      if (uv && uv.readyState >= 2 && !beforeDelay) {
        template.zones.forEach((zone, i) => {
          const tStart = typeof zone.tStart === "number" ? zone.tStart : 0;
          const tEnd = typeof zone.tEnd === "number" ? zone.tEnd : template.duration;
          if (templateTime >= tStart && templateTime < tEnd) {
            const p = placements[i];
            if (p) {
              const off = getZoneOffset(i, templateTime);
              ctx.drawImage(uv, p.x + off.dx, p.y + off.dy, p.w, p.h);
            }
          }
        });
      }

      // Template video, chroma-keyed, drawn on top of every zone's copy
      if (tv && tv.readyState >= 2 && offscreenRef.current) {
        const off = offscreenRef.current;
        const offCtx = off.getContext("2d");
        if (offCtx) {
          offCtx.drawImage(tv, 0, 0, canvasW, canvasH);
          const frame = offCtx.getImageData(0, 0, canvasW, canvasH);
          const data = frame.data;
          for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            if (g > 90 && g > 1.35 * r && g > 1.35 * b) {
              data[i + 3] = 0;
            }
          }
          offCtx.putImageData(frame, 0, 0);
          ctx.drawImage(off, 0, 0);
        }
      }

      // Zone outlines (all zones), highlighting the selected one — only once a
      // clip is loaded; an empty canvas should show no dashed clutter.
      if (userVideoUrl && propsRef.current.showZone) {
        template.zones.forEach((zone, i) => {
          ctx.save();
          ctx.strokeStyle =
            i === propsRef.current.selectedZoneIndex
              ? "rgba(255, 200, 0, 0.95)"
              : "rgba(255, 200, 0, 0.45)";
          ctx.lineWidth = 2;
          ctx.setLineDash([6, 4]);
          ctx.strokeRect(zone.x, zone.y, zone.w, zone.h);
          ctx.restore();
        });
      }

      // User video rect outlines, one per zone, selected one highlighted — moves
      // with the tracked offset so the dashed box always matches what's drawn.
      if (userVideoUrl) {
        placements.forEach((p, i) => {
          if (!p) return;
          const off = getZoneOffset(i, templateTime);
          ctx.save();
          ctx.strokeStyle =
            i === propsRef.current.selectedZoneIndex
              ? "rgba(120, 190, 255, 0.95)"
              : "rgba(120, 190, 255, 0.5)";
          ctx.lineWidth = 2;
          ctx.setLineDash([4, 4]);
          ctx.strokeRect(p.x + off.dx, p.y + off.dy, p.w, p.h);
          ctx.restore();
        });
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template, userVideoUrl, canvasW, canvasH]);

  const toCanvasScale = () => {
    const canvas = canvasRef.current;
    if (!canvas) return 1;
    const rect = canvas.getBoundingClientRect();
    return canvasW / rect.width;
  };

  const currentTemplateTime = () => templateVideoRef.current?.currentTime ?? 0;

  // Hit-tests against each zone's current ON-SCREEN rect (base placement plus
  // its tracked offset at time t, if tracking is on), since that's what's drawn.
  const hitTestZone = (canvasX: number, canvasY: number, t: number): number | null => {
    // Topmost (highest index, drawn last) wins on overlap.
    for (let i = placements.length - 1; i >= 0; i--) {
      const p = placements[i];
      if (!p) continue;
      const off = getZoneOffset(i, t);
      const vx = p.x + off.dx;
      const vy = p.y + off.dy;
      if (canvasX >= vx && canvasX <= vx + p.w && canvasY >= vy && canvasY <= vy + p.h) {
        return i;
      }
    }
    return null;
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!userVideoUrl) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scale = toCanvasScale();
    const canvasX = (e.clientX - rect.left) * scale;
    const canvasY = (e.clientY - rect.top) * scale;
    const t = currentTemplateTime();
    const hitIndex = hitTestZone(canvasX, canvasY, t);
    if (hitIndex === null) return;

    if (hitIndex !== selectedZoneIndex) onSelectZone(hitIndex);

    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const p = placements[hitIndex];
    const off = getZoneOffset(hitIndex, t);
    dragState.current = {
      dragging: true,
      zoneIndex: hitIndex,
      startClientX: e.clientX,
      startClientY: e.clientY,
      // On-screen (visual) position at drag start, not the base placement — when
      // tracked these differ by the zone's current (dx, dy).
      startX: p.x + off.dx,
      startY: p.y + off.dy,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const ds = dragState.current;
    if (!ds || !ds.dragging) return;
    const scale = toCanvasScale();
    const dx = (e.clientX - ds.startClientX) * scale;
    const dy = (e.clientY - ds.startClientY) * scale;
    // Desired on-screen position under the cursor right now...
    const visualX = ds.startX + dx;
    const visualY = ds.startY + dy;
    // ...converted back to a base placement by subtracting the zone's current
    // tracked offset, so the copy stays under the cursor even as the tracked
    // offset itself drifts (e.g. if playback continues during the drag).
    const off = getZoneOffset(ds.zoneIndex, currentTemplateTime());
    onPositionChange(ds.zoneIndex, Math.round(visualX - off.dx), Math.round(visualY - off.dy));
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragState.current) dragState.current.dragging = false;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  return (
    <div className="canvas-wrap">
      <canvas
        ref={canvasRef}
        width={canvasW}
        height={canvasH}
        className="preview-canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      />
    </div>
  );
}
