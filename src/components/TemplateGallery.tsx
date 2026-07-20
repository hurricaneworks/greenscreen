import type { Template } from "../types";

interface Props {
  templates: Template[];
  selectedId: string | null;
  onSelect: (template: Template) => void;
}

export default function TemplateGallery({ templates, selectedId, onSelect }: Props) {
  return (
    <div className="sidebar-section">
      <h2 className="sidebar-title">Templates</h2>
      <div className="template-list">
        {templates.map((t) => (
          <button
            key={t.id}
            className={
              "template-card" + (t.id === selectedId ? " template-card--selected" : "")
            }
            onClick={() => onSelect(t)}
            type="button"
          >
            <video
              className="template-card-thumb"
              src={`/templates/${t.video}`}
              preload="metadata"
              muted
            />
            <div className="template-card-info">
              <div className="template-card-name">{t.name}</div>
              <div className="template-card-duration">{t.duration.toFixed(1)}s</div>
            </div>
          </button>
        ))}
        {templates.length === 0 && (
          <p className="template-empty">No templates found.</p>
        )}
      </div>
    </div>
  );
}
