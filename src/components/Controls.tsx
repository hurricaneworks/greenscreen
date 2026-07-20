import { useEffect, useState } from "react";
import ZoneChips from "./ZoneChips";
import TrimScrubber from "./TrimScrubber";
import type { AudioMode, EndBehavior } from "../types";

interface Props {
  playing: boolean;
  onTogglePlay: () => void;
  trimStart: number;
  onTrimStartChange: (v: number) => void;
  delay: number;
  onDelayChange: (v: number) => void;
  templateDuration: number;
  audioMode: AudioMode;
  onAudioModeChange: (m: AudioMode) => void;
  endBehavior: EndBehavior;
  onEndBehaviorChange: (v: EndBehavior) => void;
  templateVolume: number;
  onTemplateVolumeChange: (v: number) => void;
  userVolume: number;
  onUserVolumeChange: (v: number) => void;
  scalePercent: number;
  onScaleChange: (v: number) => void;
  onAutoFit: () => void;
  showZone: boolean;
  onToggleZone: () => void;
  hasTracking: boolean;
  tracking: boolean;
  onTrackingChange: (v: boolean) => void;
  zoneCount: number;
  selectedZoneIndex: number;
  onSelectZone: (index: number) => void;
  hasUserVideo: boolean;
  userVideoUrl: string | null;
  userClipDuration: number;
  templateVideoRef: React.RefObject<HTMLVideoElement | null>;
  userVideoRef: React.RefObject<HTMLVideoElement | null>;
  onRender: () => void;
  rendering: boolean;
  memeName: string;
  onMemeNameChange: (v: string) => void;
}

function useLiveTemplateTime(
  templateVideoRef: React.RefObject<HTMLVideoElement | null>
): number {
  const [t, setT] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => {
      const tv = templateVideoRef.current;
      if (tv) setT(tv.currentTime);
    }, 250);
    return () => clearInterval(interval);
  }, [templateVideoRef]);
  return t;
}

export default function Controls({
  playing,
  onTogglePlay,
  trimStart,
  onTrimStartChange,
  delay,
  onDelayChange,
  templateDuration,
  audioMode,
  onAudioModeChange,
  endBehavior,
  onEndBehaviorChange,
  templateVolume,
  onTemplateVolumeChange,
  userVolume,
  onUserVolumeChange,
  scalePercent,
  onScaleChange,
  onAutoFit,
  showZone,
  onToggleZone,
  hasTracking,
  tracking,
  onTrackingChange,
  zoneCount,
  selectedZoneIndex,
  onSelectZone,
  hasUserVideo,
  userVideoUrl,
  userClipDuration,
  templateVideoRef,
  userVideoRef,
  onRender,
  rendering,
  memeName,
  onMemeNameChange,
}: Props) {
  const currentTime = useLiveTemplateTime(templateVideoRef);

  return (
    <div className="card controls">
      <div className="control-section">
        <h3 className="control-section-title">Position</h3>
        <div className="controls-row">
          {zoneCount > 1 && (
            <ZoneChips count={zoneCount} selectedIndex={selectedZoneIndex} onSelect={onSelectZone} />
          )}

          <label className="control-field">
            <span>Scale ({scalePercent}%)</span>
            <input
              type="range"
              min={25}
              max={400}
              value={scalePercent}
              disabled={!hasUserVideo}
              onChange={(e) => onScaleChange(Number(e.target.value))}
            />
          </label>

          <button className="btn btn-secondary" type="button" onClick={onAutoFit} disabled={!hasUserVideo}>
            Auto-fit
          </button>

          <button className="btn btn-secondary" type="button" onClick={onToggleZone}>
            {showZone ? "Hide zone" : "Show zone"}
          </button>

          {hasTracking && (
            <label className="control-field control-field--inline">
              <input
                type="checkbox"
                checked={tracking}
                onChange={(e) => onTrackingChange(e.target.checked)}
              />
              <span>Screen tracking</span>
            </label>
          )}
        </div>
      </div>

      <div className="control-section">
        <h3 className="control-section-title">Timing</h3>
        <div className="controls-row">
          <button className="btn" type="button" onClick={onTogglePlay}>
            {playing ? "Pause" : "Play"}
          </button>

          <span className="time-readout">
            t = {currentTime.toFixed(1)}s / {templateDuration.toFixed(1)}s
          </span>

          <label className="control-field">
            <span>Trim start (s)</span>
            <input
              type="number"
              min={0}
              step={0.1}
              value={trimStart}
              onChange={(e) => onTrimStartChange(Number(e.target.value) || 0)}
            />
          </label>

          <label className="control-field">
            <span>My clip enters at ({delay.toFixed(1)}s)</span>
            <input
              type="range"
              min={0}
              max={templateDuration}
              step={0.1}
              value={delay}
              onChange={(e) => onDelayChange(Number(e.target.value))}
            />
            <input
              type="number"
              min={0}
              max={templateDuration}
              step={0.1}
              value={delay}
              onChange={(e) => onDelayChange(Number(e.target.value) || 0)}
            />
          </label>
        </div>

        {hasUserVideo && userVideoUrl && userClipDuration > templateDuration && (
          <TrimScrubber
            userVideoUrl={userVideoUrl}
            clipDuration={userClipDuration}
            templateDuration={templateDuration}
            delay={delay}
            trimStart={trimStart}
            onTrimStartChange={onTrimStartChange}
            userVideoRef={userVideoRef}
            templateVideoRef={templateVideoRef}
          />
        )}

        <fieldset className="audio-modes end-behavior-fieldset">
          <legend>If my clip ends early:</legend>
          <label>
            <input
              type="radio"
              name="endBehavior"
              checked={endBehavior === "freeze"}
              onChange={() => onEndBehaviorChange("freeze")}
            />
            Freeze last frame
          </label>
          <label>
            <input
              type="radio"
              name="endBehavior"
              checked={endBehavior === "loop"}
              onChange={() => onEndBehaviorChange("loop")}
            />
            Loop my clip
          </label>
        </fieldset>
      </div>

      <div className="control-section">
        <h3 className="control-section-title">Audio</h3>
        <div className="controls-row">
          <fieldset className="audio-modes">
            <legend>Mode</legend>
            <label>
              <input
                type="radio"
                name="audioMode"
                checked={audioMode === "template"}
                onChange={() => onAudioModeChange("template")}
              />
              Crowd only (my clip muted)
            </label>
            <label>
              <input
                type="radio"
                name="audioMode"
                checked={audioMode === "user"}
                onChange={() => onAudioModeChange("user")}
              />
              My clip only
            </label>
            <label>
              <input
                type="radio"
                name="audioMode"
                checked={audioMode === "mix"}
                onChange={() => onAudioModeChange("mix")}
              />
              Mix both
            </label>
          </fieldset>

          <label className="control-field">
            <span>Crowd volume ({Math.round(templateVolume * 100)}%)</span>
            <input
              type="range"
              min={0}
              max={200}
              step={5}
              value={Math.round(templateVolume * 100)}
              disabled={audioMode === "user"}
              onChange={(e) => onTemplateVolumeChange(Number(e.target.value) / 100)}
            />
          </label>

          <label className="control-field">
            <span>My clip volume ({Math.round(userVolume * 100)}%)</span>
            <input
              type="range"
              min={0}
              max={200}
              step={5}
              value={Math.round(userVolume * 100)}
              disabled={audioMode === "template"}
              onChange={(e) => onUserVolumeChange(Number(e.target.value) / 100)}
            />
          </label>
        </div>
      </div>

      <div className="render-bar">
        <label className="name-field render-bar-name">
          <span>Name</span>
          <input
            type="text"
            placeholder="Name this meme"
            value={memeName}
            maxLength={80}
            onChange={(e) => onMemeNameChange(e.target.value)}
          />
        </label>

        <button
          className="btn btn-primary btn-render"
          type="button"
          onClick={onRender}
          disabled={!hasUserVideo || rendering || !memeName.trim()}
        >
          {rendering ? "Rendering…" : "Render meme"}
        </button>

        <div className="render-bar-note">
          {!memeName.trim() && <p className="name-hint">Name your meme to render.</p>}
          <p className="note">
            {endBehavior === "loop"
              ? "Clips shorter than the template loop from the start (after finishing the trimmed first pass)."
              : "Clips shorter than the template freeze on their last frame."}
          </p>
        </div>
      </div>
    </div>
  );
}
