import { ToggleButton } from "./Button";
import type { SessionFilter } from "../types";

/** Render conversation filters while keeping URL state owned by the page. */
export function FilterTabs(props: {
  current: SessionFilter;
  onChange(filter: SessionFilter): void;
}) {
  const filters: SessionFilter[] = [
    "recent",
    "active",
    "hung",
    "failed",
    "all",
  ];
  return (
    <div
      aria-label="Conversation filter"
      className="flex flex-wrap items-center justify-end gap-1"
      role="group"
    >
      {filters.map((filter) => (
        <ToggleButton
          key={filter}
          onClick={() => props.onChange(filter)}
          pressed={props.current === filter}
          variant="pill"
        >
          {filter}
        </ToggleButton>
      ))}
    </div>
  );
}
