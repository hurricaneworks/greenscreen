import { useState } from "react";

interface Props {
  onFetched: (id: string, title: string) => void;
}

function parseTimeInput(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes(":")) {
    const parts = trimmed.split(":").map((p) => Number(p));
    if (parts.some((p) => !Number.isFinite(p))) return undefined;
    let seconds = 0;
    for (const part of parts) {
      seconds = seconds * 60 + part;
    }
    return seconds;
  }
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

export default function YouTubeCapture({ onFetched }: Props) {
  const [url, setUrl] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFetch = async () => {
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const start = parseTimeInput(from);
      const end = parseTimeInput(to);
      const body: Record<string, unknown> = { url: url.trim() };
      if (start !== undefined || end !== undefined) {
        body.start = start ?? 0;
        body.end = end;
      }
      const res = await fetch("/api/youtube", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to fetch video");
      }
      onFetched(data.id, data.title || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="yt-capture">
      <span className="yt-capture-label">…or grab from YouTube</span>
      <div className="yt-capture-row">
        <input
          type="text"
          className="yt-url-input"
          placeholder="https://youtube.com/watch?v=..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <input
          type="text"
          className="yt-time-input"
          placeholder="from (mm:ss)"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <input
          type="text"
          className="yt-time-input"
          placeholder="to (mm:ss)"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-secondary"
          onClick={handleFetch}
          disabled={busy || !url.trim()}
        >
          {busy ? "Fetching…" : "Fetch"}
        </button>
      </div>
      {error && <p className="yt-capture-error">{error}</p>}
    </div>
  );
}
