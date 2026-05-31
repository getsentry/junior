import { cn } from "../styles";
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
    <div className="flex flex-wrap items-center justify-end gap-1">
      {filters.map((filter) => (
        <button
          className={cn(
            "cursor-pointer border px-2 py-1 text-[0.78rem] font-semibold uppercase leading-tight transition-colors",
            props.current === filter
              ? "border-white/30 bg-white text-black"
              : "border-white/10 bg-[#0b0b0b] text-[#888] hover:border-white/25 hover:bg-[#151515] hover:text-white",
          )}
          key={filter}
          onClick={() => props.onChange(filter)}
          type="button"
        >
          {filter}
        </button>
      ))}
    </div>
  );
}
