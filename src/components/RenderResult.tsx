import { useEffect, useRef, useState } from "react";
import type { RenderResultData } from "../types";

interface Props {
  result: RenderResultData | null;
  error: string | null;
  rendering: boolean;
  // Fired when the rendered meme starts playing, so the editor preview
  // (which otherwise loops forever underneath) can pause itself.
  onPlay: () => void;
}

export default function RenderResult({ result, error, rendering, onPlay }: Props) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [highlight, setHighlight] = useState(false);

  // Bring the result into view and briefly highlight it whenever a new render
  // lands (render success or a "Play" from the meme library).
  useEffect(() => {
    if (!result?.url) return;
    cardRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    setHighlight(true);
    const timer = setTimeout(() => setHighlight(false), 1500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.url]);

  if (!rendering && !result && !error) return null;

  return (
    <div
      ref={cardRef}
      className={"card render-result" + (highlight ? " render-result--highlight" : "")}
    >
      {rendering && <p>Rendering your meme… this can take a few seconds.</p>}
      {error && (
        <div className="render-error">
          <p>Render failed:</p>
          <pre>{error}</pre>
        </div>
      )}
      {result && (
        <div className="render-success">
          <video src={result.url} controls className="render-video" onPlay={onPlay} />
          <a className="btn btn-secondary" href={result.url} download={result.name}>
            Download
          </a>
        </div>
      )}
    </div>
  );
}
