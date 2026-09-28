import { FilterChip, type Chip } from "./FilterChip";

/** The design export's QueryBreakdown: the quoted sentence, then its chips. */
export function QueryBreakdown({
  query,
  chips,
  onRemove,
  lead = "Understood as",
}: {
  query: string;
  chips: Chip[];
  onRemove?: (chip: Chip) => void;
  lead?: string;
}) {
  return (
    <div className="unf-breakdown">
      <p className="unf-breakdown__q">
        {"“"}
        {query}
        {"”"}
      </p>
      <div className="unf-breakdown__chips">
        <span className="unf-breakdown__lead">{lead}</span>
        {chips.map((chip) => (
          <FilterChip
            key={chip.label}
            label={chip.label}
            variant={chip.variant}
            onRemove={onRemove ? () => onRemove(chip) : undefined}
          />
        ))}
      </div>
    </div>
  );
}
