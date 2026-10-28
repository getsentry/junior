import type { Ref } from "react";
import { Search, X } from "lucide-react";

import { cn } from "../styles";

type SearchInputSize = "compact" | "default";

/** Render the dashboard's standard search input with distinct value and placeholder text. */
export function SearchInput(props: {
  className?: string;
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
          "w-full rounded-md border border-dashboard-border font-sans text-sm text-dashboard-text outline-none transition-colors placeholder:text-dashboard-text-muted/70 hover:border-dashboard-border-emphasis focus:border-dashboard-focus [&::-webkit-search-cancel-button]:appearance-none",
          searchInputClass[size],
        )}
        onChange={(event) => props.onChange(event.currentTarget.value)}
        placeholder={props.placeholder}
        ref={props.inputRef}
        type="search"
        value={props.value}
      />
      {props.value ? (
        <button
          aria-label="Clear search"
          className={cn(
            "absolute top-1/2 grid size-6 -translate-y-1/2 cursor-pointer place-items-center rounded-md text-dashboard-text-muted transition-colors hover:bg-dashboard-fill-strong hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-dashboard-focus",
            clearButtonClass[size],
          )}
          onClick={(event) => {
            props.onChange("");
            // The button unmounts once the value is empty, so keep focus in the search box.
            event.currentTarget.parentElement?.querySelector("input")?.focus();
          }}
          type="button"
        >
          <X aria-hidden="true" size={14} strokeWidth={2.5} />
        </button>
      ) : null}
    </div>
  );
}

const searchIconClass: Record<SearchInputSize, string> = {
  compact: "left-2.5",
  default: "left-3",
};

const clearButtonClass: Record<SearchInputSize, string> = {
  compact: "right-1.5",
  default: "right-2",
};

const searchInputClass: Record<SearchInputSize, string> = {
  compact:
    "h-9 bg-dashboard-overlay-soft pr-8 pl-8 focus:ring-1 focus:ring-dashboard-focus/25",
  default:
    "h-10 bg-dashboard-overlay-soft pr-9 pl-9 focus:ring-1 focus:ring-dashboard-focus/25",
};
