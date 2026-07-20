interface Props {
  count: number;
  selectedIndex: number;
  onSelect: (index: number) => void;
}

export default function ZoneChips({ count, selectedIndex, onSelect }: Props) {
  if (count <= 1) return null;

  return (
    <div className="zone-chips">
      {Array.from({ length: count }, (_, i) => (
        <button
          key={i}
          type="button"
          className={"zone-chip" + (i === selectedIndex ? " zone-chip--active" : "")}
          onClick={() => onSelect(i)}
        >
          Screen {i + 1}
        </button>
      ))}
    </div>
  );
}
