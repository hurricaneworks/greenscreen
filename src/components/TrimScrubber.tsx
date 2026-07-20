import { useEffect, useRef, useState } from "react";

interface Props {
  userVideoUrl: string;
  clipDuration: number;
  templateDuration: number;
  delay: number;
  trimStart: number;
  onTrimStartChange: (v: number) => void;
  userVideoRef: React.RefObject<HTMLVideoElement | null>;
  templateVideoRef: React.RefObject<HTMLVideoElement | null>;
}

const THUMB_COUNT = 10;
const DRAG_THRESHOLD_PX = 4;

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function TrimScrubber({
  userVideoUrl,
  clipDuration,
  templateDuration,
  delay,
  trimStart,
  onTrimStartChange,
  userVideoRef,
  templateVideoRef,
}: Props) {
  const [thumbs, setThumbs] = useState<string[] | null>(null);
  const [playheadTime, setPlayheadTime] = useState(0);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    dragging: boolean;
    startClientX: number;
    startTrim: number;
    moved: boolean;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setThumbs(null);

    if (!clipDuration || !Number.isFinite(clipDuration) || clipDuration <= 0) {
      return;
    }

    const video = document.createElement("video");
    video.src = userVideoUrl;
    video.muted = true;
    video.preload = "auto";

    const canvas = document.createElement("canvas");
    const results: string[] = [];

    const seekAndCapture = (index: number): Promise<void> => {
      return new Promise((resolve, reject) => {
        const t = (clipDuration * (index + 0.5)) / THUMB_COUNT;
        const onSeeked = () => {
          video.removeEventListener("seeked", onSeeked);
          try {
            const aspect = video.videoWidth / video.videoHeight || 16 / 9;
            const h = 64;
            const w = Math.round(h * aspect);
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext("2d");
            if (ctx) {
              ctx.drawImage(video, 0, 0, w, h);
              results.push(canvas.toDataURL("image/jpeg", 0.6));
            } else {
              reject(new Error("no 2d context"));
              return;
            }
            resolve();
          } catch (err) {
            reject(err);
          }
        };
        video.addEventListener("seeked", onSeeked);
        video.currentTime = Math.min(t, Math.max(clipDuration - 0.05, 0));
      });
    };

    const onLoaded = async () => {
      try {
        for (let i = 0; i < THUMB_COUNT; i++) {
          if (cancelled) return;
          await seekAndCapture(i);
        }
        if (!cancelled) setThumbs(results);
      } catch {
        if (!cancelled) setThumbs(null);
      }
    };

    video.addEventListener("loadedmetadata", onLoaded);
    return () => {
      cancelled = true;
      video.removeEventListener("loadedmetadata", onLoaded);
      video.src = "";
    };
  }, [userVideoUrl, clipDuration]);

  // Lightweight local polling of the user clip's own playback position, purely
  // for the playhead line — deliberately not lifted into App state.
  useEffect(() => {
    const interval = setInterval(() => {
      const uv = userVideoRef.current;
      if (uv) setPlayheadTime(uv.currentTime);
    }, 100);
    return () => clearInterval(interval);
  }, [userVideoRef]);

  const sliceDuration = Math.max(templateDuration - delay, 0.1);
  const windowFrac = Math.min(sliceDuration / clipDuration, 1);
  const maxTrim = Math.max(clipDuration - sliceDuration, 0);
  const clampedTrim = Math.min(Math.max(trimStart, 0), maxTrim);
  const leftFrac = clipDuration > 0 ? clampedTrim / clipDuration : 0;
  const playheadFrac = clipDuration > 0 ? Math.min(Math.max(playheadTime / clipDuration, 0), 1) : 0;

  const seekTo = (clipTime: number) => {
    const uv = userVideoRef.current;
    const tv = templateVideoRef.current;
    const clamped = Math.min(Math.max(clipTime, 0), clipDuration);
    if (uv) uv.currentTime = clamped;
    if (tv) {
      const templateTime = Math.min(Math.max(clamped - trimStart + delay, 0), templateDuration);
      tv.currentTime = templateTime;
    }
    setPlayheadTime(clamped);
  };

  const clipTimeFromClientX = (clientX: number): number => {
    const rect = stripRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    const frac = (clientX - rect.left) / rect.width;
    return Math.min(Math.max(frac * clipDuration, 0), clipDuration);
  };

  const handleWindowPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      dragging: true,
      startClientX: e.clientX,
      startTrim: clampedTrim,
      moved: false,
    };
  };

  const handleWindowPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const ds = dragRef.current;
    if (!ds || !ds.dragging || !stripRef.current) return;
    if (Math.abs(e.clientX - ds.startClientX) > DRAG_THRESHOLD_PX) ds.moved = true;
    if (!ds.moved) return;
    const rect = stripRef.current.getBoundingClientRect();
    const dxFrac = (e.clientX - ds.startClientX) / rect.width;
    const dxSeconds = dxFrac * clipDuration;
    const next = Math.min(Math.max(ds.startTrim + dxSeconds, 0), maxTrim);
    onTrimStartChange(Number(next.toFixed(2)));
  };

  const handleWindowPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const ds = dragRef.current;
    if (ds && ds.dragging && !ds.moved) {
      // A plain click (no drag) inside the window: seek the preview there
      // without moving the trim window itself.
      seekTo(clipTimeFromClientX(e.clientX));
    }
    if (dragRef.current) dragRef.current.dragging = false;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  // Click on the strip OUTSIDE the window: re-centre the window there (the
  // window's own pointerdown stops propagation, so this only fires for clicks
  // that land on the thumbnail strip itself).
  const handleStripPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const clickedTime = clipTimeFromClientX(e.clientX);
    const newTrim = Math.min(Math.max(clickedTime - sliceDuration / 2, 0), maxTrim);
    onTrimStartChange(Number(newTrim.toFixed(2)));
  };

  return (
    <div className="scrubber">
      <div className="scrubber-strip" ref={stripRef} onPointerDown={handleStripPointerDown}>
        {thumbs ? (
          thumbs.map((src, i) => (
            <img key={i} src={src} className="scrubber-thumb" alt="" draggable={false} />
          ))
        ) : (
          <div className="scrubber-fallback" />
        )}
        <div
          className="scrubber-window"
          style={{
            left: `${leftFrac * 100}%`,
            width: `${windowFrac * 100}%`,
          }}
          onPointerDown={handleWindowPointerDown}
          onPointerMove={handleWindowPointerMove}
          onPointerUp={handleWindowPointerUp}
        >
          <span className="scrubber-window-label">{formatTime(clampedTrim)}</span>
        </div>
        <div className="scrubber-playhead" style={{ left: `${playheadFrac * 100}%` }} />
      </div>
      <div className="scrubber-total">{formatTime(clipDuration)}</div>
    </div>
  );
}
