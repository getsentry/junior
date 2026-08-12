import type { Ref } from "react";
import { Search } from "lucide-react";

import { cn } from "../styles";

type SearchInputSize = "compact" | "default";

/** Render the dashboard's standard search input with distinct value and placeholder text. */
export function SearchInput(props: {
  className?: string;
  id?: string;
  inputRef?: Ref<HTMLInputElement>;
  label: string;
  onChange(value: string): void;
  placeholder: string;
  size?: SearchInputSize;
  value: string;
}) {
  const size = props.size ?? "compact";
  return (
    <div className={cn("relative min-w-0", props.className)}>
      <Search
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute top-1/2 -translate-y-1/2 text-dashboard-text-muted",
          searchIconClass[size],
        )}
        size={size === "compact" ? 13 : 14}
        strokeWidth={2.5}
      />
      <input
        aria-label={props.label}
        className={cn(
          "w-full rounded-lg border border-white/[0.08] font-mono text-xs text-dashboard-text outline-none transition-colors placeholder:text-dashboard-text-muted hover:border-white/15",
          searchInputClass[size],
        )}
        id={props.id}
        onChange={(event) => props.onChange(event.currentTarget.value)}
        placeholder={props.placeholder}
        ref={props.inputRef}
        type="search"
        value={props.value}
      />
    </div>
  );
}

const searchIconClass: Record<SearchInputSize, string> = {
  compact: "left-2.5",
  default: "left-3",
};

const searchInputClass: Record<SearchInputSize, string> = {
  compact:
    "h-9 bg-black/25 pr-3 pl-8 focus:border-cyan-400/30 focus:ring-1 focus:ring-cyan-400/15",
  default:
    "h-10 bg-black/20 pr-3 pl-9 focus:border-cyan-300/35 focus:ring-2 focus:ring-cyan-300/10",
};
