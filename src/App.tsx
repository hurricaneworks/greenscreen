import { useCallback, useEffect, useRef, useState } from "react";
import TemplateGallery from "./components/TemplateGallery";
import PreviewCanvas from "./components/PreviewCanvas";
import Controls from "./components/Controls";
import RenderResult from "./components/RenderResult";
import MemeLibrary from "./components/MemeLibrary";
import YouTubeCapture from "./components/YouTubeCapture";
import type {
  AudioMode,
  EndBehavior,
  Meme,
  Placement,
  RenderResultData,
  Template,
  TemplateZone,
  UserSource,
} from "./types";

interface ZoneState {
  x: number;
  y: number;
  autoFitW: number;
  autoFitH: number;
  scalePercent: number;
}

function computeAutoFit(zone: TemplateZone, aspect: number) {
  const w = Math.max(zone.w, zone.h * aspect);
  const h = w / aspect;
  const x = Math.round(zone.x + (zone.w - w) / 2);
  const y = Math.round(zone.y + (zone.h - h) / 2);
  return { w: Math.round(w), h: Math.round(h), x, y };
}

function computeAllZoneStates(template: Template, aspect: number): ZoneState[] {
  return template.zones.map((zone) => {
    const fit = computeAutoFit(zone, aspect);
    return { x: fit.x, y: fit.y, autoFitW: fit.w, autoFitH: fit.h, scalePercent: 100 };
  });
}

export default function App() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null);

  const [userSource, setUserSource] = useState<UserSource | null>(null);
  const [userVideoUrl, setUserVideoUrl] = useState<string | null>(null);
  const [userAspect, setUserAspect] = useState<number>(16 / 9);
  const [userClipDuration, setUserClipDuration] = useState(0);

  const [zoneStates, setZoneStates] = useState<ZoneState[]>([]);
  const [selectedZoneIndex, setSelectedZoneIndex] = useState(0);

  const [trimStart, setTrimStart] = useState(0);
  const [delay, setDelay] = useState(0);
  const [audioMode, setAudioMode] = useState<AudioMode>("template");
  const [endBehavior, setEndBehavior] = useState<EndBehavior>("freeze");
  const [templateVolume, setTemplateVolume] = useState(1);
  const [userVolume, setUserVolume] = useState(1);
  const [tracking, setTracking] = useState(true);
  const [playing, setPlaying] = useState(true);
  const [showZone, setShowZone] = useState(true);

  const [uploading, setUploading] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [renderResult, setRenderResult] = useState<RenderResultData | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  const [memeName, setMemeName] = useState("");
  const [memes, setMemes] = useState<Meme[]>([]);

  const templateVideoRef = useRef<HTMLVideoElement | null>(null);
  const userVideoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Placements to restore once the (re-)loaded clip's metadata gives us its aspect
  // ratio — used by the Edit flow. Index-aligned with the target template's zones.
  const pendingRestoreRef = useRef<Placement[] | null>(null);

  // Preview volume for the crowd audio. The media element caps at 1.0, so
  // boost settings (>100%) only fully apply in the rendered output.
  useEffect(() => {
    const tv = templateVideoRef.current;
    if (tv) tv.volume = Math.min(templateVolume, 1);
  }, [templateVolume, userVideoUrl]);

  useEffect(() => {
    const uv = userVideoRef.current;
    if (uv) uv.volume = Math.min(userVolume, 1);
  }, [userVolume, userVideoUrl]);

  const fetchMemes = useCallback(() => {
    fetch("/api/memes")
      .then((r) => r.json())
      .then((data: Meme[]) => setMemes(data))
      .catch(() => {
        // leave existing list as-is on transient failure
      });
  }, []);

  useEffect(() => {
    fetch("/api/templates")
      .then((r) => r.json())
      .then((data: Template[]) => {
        setTemplates(data);
        if (data.length > 0) setSelectedTemplate(data[0]);
      })
      .catch(() => {
        setTemplates([]);
      });
    fetchMemes();
  }, [fetchMemes]);

  const placements: { x: number; y: number; w: number; h: number }[] = zoneStates.map(
    (z) => ({
      x: z.x,
      y: z.y,
      w: (z.autoFitW * z.scalePercent) / 100,
      h: (z.autoFitH * z.scalePercent) / 100,
    })
  );
  const selectedZone = zoneStates[selectedZoneIndex] as ZoneState | undefined;
  const hasTracking = selectedTemplate ? selectedTemplate.zones.some((z) => !!z.track) : false;

  const applySource = useCallback(
    (source: UserSource, url: string, isEdit = false) => {
      setUserSource(source);
      setRenderResult(null);
      setRenderError(null);
      if (!isEdit) {
        setTrimStart(0);
        setDelay(0);
        setEndBehavior("freeze");
        setTracking(true);
        pendingRestoreRef.current = null;
      }
      setUserClipDuration(0);
      setUserVideoUrl(url);
    },
    []
  );

  const applyLocalFile = useCallback(
    (file: File) => {
      const url = URL.createObjectURL(file);
      applySource({ kind: "local", file }, url);
      setMemeName("");
    },
    [applySource]
  );

  const handleUserVideoMeta = useCallback(() => {
    const uv = userVideoRef.current;
    const tmpl = selectedTemplate;
    if (!uv || !tmpl || !uv.videoWidth || !uv.videoHeight) return;
    const aspect = uv.videoWidth / uv.videoHeight;
    setUserAspect(aspect);
    if (Number.isFinite(uv.duration)) setUserClipDuration(uv.duration);

    const pending = pendingRestoreRef.current;
    if (pending) {
      const restored = tmpl.zones.map((zone, i) => {
        const fit = computeAutoFit(zone, aspect);
        const p = pending[i];
        if (p) {
          const scale = fit.w > 0 ? (p.w / fit.w) * 100 : 100;
          return {
            x: p.x,
            y: p.y,
            autoFitW: fit.w,
            autoFitH: fit.h,
            scalePercent: Math.min(Math.max(scale, 25), 400),
          };
        }
        return { x: fit.x, y: fit.y, autoFitW: fit.w, autoFitH: fit.h, scalePercent: 100 };
      });
      setZoneStates(restored);
      pendingRestoreRef.current = null;
    } else {
      setZoneStates(computeAllZoneStates(tmpl, aspect));
    }
    setSelectedZoneIndex(0);
  }, [selectedTemplate]);

  const handleAutoFit = useCallback(() => {
    if (!selectedTemplate) return;
    const zone = selectedTemplate.zones[selectedZoneIndex];
    if (!zone) return;
    const fit = computeAutoFit(zone, userAspect);
    setZoneStates((prev) =>
      prev.map((z, i) =>
        i === selectedZoneIndex
          ? { x: fit.x, y: fit.y, autoFitW: fit.w, autoFitH: fit.h, scalePercent: 100 }
          : z
      )
    );
  }, [selectedTemplate, selectedZoneIndex, userAspect]);

  const handleScaleChange = useCallback(
    (newScale: number) => {
      setZoneStates((prev) =>
        prev.map((z, i) => {
          if (i !== selectedZoneIndex) return z;
          const curW = (z.autoFitW * z.scalePercent) / 100;
          const curH = (z.autoFitH * z.scalePercent) / 100;
          const newW = (z.autoFitW * newScale) / 100;
          const newH = (z.autoFitH * newScale) / 100;
          const centerX = z.x + curW / 2;
          const centerY = z.y + curH / 2;
          return {
            ...z,
            scalePercent: newScale,
            x: Math.round(centerX - newW / 2),
            y: Math.round(centerY - newH / 2),
          };
        })
      );
    },
    [selectedZoneIndex]
  );

  const handlePositionChange = useCallback((zoneIndex: number, x: number, y: number) => {
    setZoneStates((prev) => prev.map((z, i) => (i === zoneIndex ? { ...z, x, y } : z)));
  }, []);

  const handleSelectZone = useCallback((index: number) => {
    setSelectedZoneIndex(index);
  }, []);

  const handleSelectTemplate = useCallback(
    (t: Template) => {
      setSelectedTemplate(t);
      setPlaying(true);
      setRenderResult(null);
      setRenderError(null);
      setSelectedZoneIndex(0);
      if (userVideoUrl) {
        setZoneStates(computeAllZoneStates(t, userAspect));
      } else {
        setZoneStates([]);
      }
    },
    [userVideoUrl, userAspect]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const file = e.dataTransfer.files?.[0];
      if (file) applyLocalFile(file);
    },
    [applyLocalFile]
  );

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  }, []);

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) applyLocalFile(file);
    },
    [applyLocalFile]
  );

  const handleYouTubeFetched = useCallback(
    async (id: string, title: string) => {
      try {
        const res = await fetch(`/api/upload-file/${encodeURIComponent(id)}`);
        if (!res.ok) throw new Error("Could not load fetched clip");
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        applySource({ kind: "server", uploadId: id, fileName: id }, url);
        setMemeName(title);
      } catch (err) {
        setRenderError(err instanceof Error ? err.message : String(err));
      }
    },
    [applySource]
  );

  const handleRender = useCallback(async () => {
    if (!userSource || !selectedTemplate || !memeName.trim()) return;
    setRendering(true);
    setRenderError(null);
    setRenderResult(null);
    try {
      let id: string;
      if (userSource.kind === "server") {
        id = userSource.uploadId;
      } else {
        setUploading(true);
        const uploadRes = await fetch(
          `/api/upload?name=${encodeURIComponent(userSource.file.name)}`,
          {
            method: "POST",
            headers: { "Content-Type": "video/*" },
            body: userSource.file,
          }
        );
        if (!uploadRes.ok) {
          const body = await uploadRes.json().catch(() => ({ error: "Upload failed" }));
          throw new Error(body.error || "Upload failed");
        }
        const uploadBody = await uploadRes.json();
        id = uploadBody.id;
        setUploading(false);
      }

      const renderPlacements: Placement[] = zoneStates.map((z) => ({
        x: Math.round(z.x),
        y: Math.round(z.y),
        w: Math.round((z.autoFitW * z.scalePercent) / 100),
      }));

      const renderRes = await fetch("/api/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uploadId: id,
          templateId: selectedTemplate.id,
          placements: renderPlacements,
          trimStart,
          delay,
          audioMode,
          endBehavior,
          templateVolume,
          userVolume,
          tracking,
          name: memeName,
        }),
      });
      const renderBody = await renderRes.json();
      if (!renderRes.ok) {
        throw new Error(renderBody.error || "Render failed");
      }
      setRenderResult(renderBody as RenderResultData);
      fetchMemes();
    } catch (err) {
      setRenderError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      setRendering(false);
    }
  }, [
    userSource,
    selectedTemplate,
    zoneStates,
    trimStart,
    delay,
    audioMode,
    endBehavior,
    templateVolume,
    userVolume,
    tracking,
    memeName,
    fetchMemes,
  ]);

  const templateNameById = useCallback(
    (id: string) => templates.find((t) => t.id === id)?.name ?? id,
    [templates]
  );

  const handlePlayMeme = useCallback((meme: Meme) => {
    setRenderError(null);
    setPlaying(false);
    setRenderResult({
      url: `/api/file/${meme.slug}/output.mp4`,
      name: `${meme.slug}.mp4`,
      slug: meme.slug,
    });
  }, []);

  const handleEditMeme = useCallback(
    async (meme: Meme) => {
      try {
        const tmpl = templates.find((t) => t.id === meme.templateId);
        if (tmpl) setSelectedTemplate(tmpl);

        const res = await fetch(`/api/file/${meme.slug}/${meme.sourceFile}`);
        if (!res.ok) throw new Error("Could not load source clip for editing");
        const blob = await res.blob();
        const file = new File([blob], meme.sourceFile, {
          type: blob.type || "video/mp4",
        });
        const url = URL.createObjectURL(file);

        // Normalize legacy single-zone (flat x/y/w) memes into a placements array.
        const restorePlacements: Placement[] = meme.params.placements
          ? meme.params.placements
          : [
              {
                x: meme.params.x ?? 0,
                y: meme.params.y ?? 0,
                w: meme.params.w ?? 100,
              },
            ];

        pendingRestoreRef.current = restorePlacements;
        applySource({ kind: "local", file }, url, true);
        setTrimStart(meme.params.trimStart);
        setDelay(meme.params.delay);
        setAudioMode(meme.params.audioMode);
        setEndBehavior(meme.params.endBehavior ?? "freeze");
        setTemplateVolume(meme.params.templateVolume ?? 1);
        setUserVolume(meme.params.userVolume ?? 1);
        setTracking(meme.params.tracking ?? true);
        setMemeName(meme.name);
        setPlaying(true);
      } catch (err) {
        setRenderError(err instanceof Error ? err.message : String(err));
      }
    },
    [templates, applySource]
  );

  const handleNewMeme = useCallback(() => {
    if (userVideoUrl) URL.revokeObjectURL(userVideoUrl);
    pendingRestoreRef.current = null;
    setUserSource(null);
    setUserVideoUrl(null);
    setUserClipDuration(0);
    setZoneStates([]);
    setSelectedZoneIndex(0);
    setTrimStart(0);
    setDelay(0);
    setAudioMode(selectedTemplate?.defaultAudio === "user" ? "user" : "template");
    setEndBehavior("freeze");
    setTemplateVolume(1);
    setUserVolume(1);
    setTracking(true);
    setMemeName("");
    setRenderResult(null);
    setRenderError(null);
    setPlaying(true);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [userVideoUrl, selectedTemplate]);

  const handleDeleteMeme = useCallback(
    (meme: Meme) => {
      if (!window.confirm(`Delete "${meme.name}"? This cannot be undone.`)) return;
      fetch(`/api/memes/${meme.slug}`, { method: "DELETE" })
        .then(() => fetchMemes())
        .catch(() => {
          // leave list as-is; user can retry
        });
    },
    [fetchMemes]
  );

  return (
    <div className="app">
      <aside className="sidebar">
        <TemplateGallery
          templates={templates}
          selectedId={selectedTemplate?.id ?? null}
          onSelect={handleSelectTemplate}
        />
        <MemeLibrary
          memes={memes}
          templateNameById={templateNameById}
          onPlay={handlePlayMeme}
          onEdit={handleEditMeme}
          onDelete={handleDeleteMeme}
        />
      </aside>

      <main className="main">
        <h1 className="title">Green Screen Meme Maker</h1>

        {selectedTemplate ? (
          <>
            <div
              className={"drop-area" + (userVideoUrl ? "" : " drop-area--empty")}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onClick={() => {
                if (!userVideoUrl) fileInputRef.current?.click();
              }}
            >
              <div className="canvas-stage">
                <PreviewCanvas
                  template={selectedTemplate}
                  userVideoUrl={userVideoUrl}
                  placements={placements}
                  selectedZoneIndex={selectedZoneIndex}
                  onSelectZone={handleSelectZone}
                  onPositionChange={handlePositionChange}
                  trimStart={trimStart}
                  delay={delay}
                  audioMode={audioMode}
                  endBehavior={endBehavior}
                  tracking={tracking}
                  playing={playing}
                  showZone={showZone}
                  templateVideoRef={templateVideoRef}
                  userVideoRef={userVideoRef}
                />
                {!userVideoUrl && (
                  <div className="drop-hint">
                    <div className="drop-hint-title">Drop a video here</div>
                    <div className="drop-hint-sub">— or click to choose a file</div>
                  </div>
                )}
              </div>

              {!userVideoUrl && (
                <div className="yt-capture-panel" onClick={(e) => e.stopPropagation()}>
                  <YouTubeCapture onFetched={handleYouTubeFetched} />
                </div>
              )}
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="video/*"
              className="visually-hidden"
              onChange={handleFileInputChange}
            />

            {userVideoUrl && (
              <div className="video-actions">
                <button
                  type="button"
                  className="btn btn-secondary change-video-btn"
                  onClick={() => fileInputRef.current?.click()}
                >
                  Change video
                </button>
                <button
                  type="button"
                  className="btn btn-secondary new-meme-btn"
                  onClick={handleNewMeme}
                >
                  New meme
                </button>
              </div>
            )}

            <Controls
              playing={playing}
              onTogglePlay={() => setPlaying((p) => !p)}
              trimStart={trimStart}
              onTrimStartChange={setTrimStart}
              delay={delay}
              onDelayChange={setDelay}
              templateDuration={selectedTemplate.duration}
              audioMode={audioMode}
              onAudioModeChange={setAudioMode}
              endBehavior={endBehavior}
              onEndBehaviorChange={setEndBehavior}
              templateVolume={templateVolume}
              onTemplateVolumeChange={setTemplateVolume}
              userVolume={userVolume}
              onUserVolumeChange={setUserVolume}
              scalePercent={selectedZone ? selectedZone.scalePercent : 100}
              onScaleChange={handleScaleChange}
              onAutoFit={handleAutoFit}
              showZone={showZone}
              onToggleZone={() => setShowZone((s) => !s)}
              hasTracking={hasTracking}
              tracking={tracking}
              onTrackingChange={setTracking}
              zoneCount={selectedTemplate.zones.length}
              selectedZoneIndex={selectedZoneIndex}
              onSelectZone={handleSelectZone}
              hasUserVideo={!!userVideoUrl}
              userVideoUrl={userVideoUrl}
              userClipDuration={userClipDuration}
              templateVideoRef={templateVideoRef}
              userVideoRef={userVideoRef}
              onRender={handleRender}
              rendering={rendering || uploading}
              memeName={memeName}
              onMemeNameChange={setMemeName}
            />

            <RenderResult
              result={renderResult}
              error={renderError}
              rendering={rendering || uploading}
              onPlay={() => setPlaying(false)}
            />

            {/* Hidden source video elements driving the canvas preview */}
            <video
              ref={templateVideoRef}
              src={`/templates/${selectedTemplate.video}`}
              className="visually-hidden"
              playsInline
              autoPlay
              muted={!(audioMode === "template" || audioMode === "mix")}
            />
            {userVideoUrl && (
              <video
                ref={userVideoRef}
                src={userVideoUrl}
                className="visually-hidden"
                playsInline
                onLoadedMetadata={handleUserVideoMeta}
                muted={!(audioMode === "user" || audioMode === "mix")}
              />
            )}
          </>
        ) : (
          <p>Loading templates…</p>
        )}
      </main>
    </div>
  );
}
