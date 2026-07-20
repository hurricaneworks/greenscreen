import type { Meme } from "../types";

interface Props {
  memes: Meme[];
  templateNameById: (id: string) => string;
  onPlay: (meme: Meme) => void;
  onEdit: (meme: Meme) => void;
  onDelete: (meme: Meme) => void;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function MemeLibrary({ memes, templateNameById, onPlay, onEdit, onDelete }: Props) {
  return (
    <div className="sidebar-section meme-library-sidebar">
      <h2 className="sidebar-title">My memes</h2>
      {memes.length === 0 ? (
        <p className="template-empty">No memes rendered yet.</p>
      ) : (
        <div className="meme-list-compact">
          {memes.map((meme) => (
            <div key={meme.slug} className="meme-row-compact">
              <div className="meme-row-compact-name" title={meme.name}>
                {meme.name}
              </div>
              <div className="meme-row-compact-meta">
                {formatDate(meme.createdAt)} &middot; {templateNameById(meme.templateId)}
              </div>
              <div className="meme-row-compact-actions">
                <button className="btn btn-tiny" type="button" onClick={() => onPlay(meme)}>
                  Play
                </button>
                <a
                  className="btn btn-tiny"
                  href={`/api/file/${meme.slug}/output.mp4`}
                  download={`${meme.slug}.mp4`}
                >
                  DL
                </a>
                <button className="btn btn-tiny" type="button" onClick={() => onEdit(meme)}>
                  Edit
                </button>
                <button
                  className="btn btn-tiny btn-danger"
                  type="button"
                  onClick={() => onDelete(meme)}
                >
                  Del
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
