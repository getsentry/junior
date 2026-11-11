import { useState, type ReactNode } from "react";
import { Check } from "lucide-react";

import { DetailsPanel } from "../DetailsPanel";
import { Button } from "../ui/button";
import { cn } from "../../styles";

/** One choice in a `FilterOptions` list. */
export type FilterOption = { label: string; value: string };

// Long option lists show this many options until expanded.
const COLLAPSED_OPTIONS = 6;

/**
 * Edit page filters in the same side panel as row details: beside the list
 * on wide screens, a modal sheet elsewhere. Render it as the `details` of a
 * `ListPanelFrame`. Choices apply at once. Put one `FilterOptions` in it per
 * filter.
 */
export function FilterPanel(props: {
  children: ReactNode;
  /** Clears every filter. Shown only while a filter is set. */
  onClear?(): void;
  onClose(): void;
}) {
  return (
    <DetailsPanel
      actions={
        props.onClear ? (
          <Button onClick={props.onClear} variant="quiet">
            Clear all
          </Button>
        ) : undefined
      }
      label="Filters"
      onClose={props.onClose}
      sheetTitle="Filters"
      title={
        <h2 className="m-0 font-display text-base font-medium text-dashboard-text">
          Filters
        </h2>
      }
    >
      <div className="grid divide-y divide-dashboard-border-subtle px-3">
        {props.children}
      </div>
    </DetailsPanel>
  );
}

/**
 * One filter as a list of pressable options under a heading, so every
 * choice is visible without a menu. "All" (value `""`) clears it. A long
 * list shows its first options and the selected one until expanded.
 */
export function FilterOptions(props: {
  label: string;
  onChange(value: string): void;
  options: readonly FilterOption[];
  value: string;
}) {
  const [expanded, setExpanded] = useState(false);
  // A shared URL can select a value that the loaded options do not list.
  const options =
    props.value && !props.options.some((option) => option.value === props.value)
      ? [...props.options, { label: props.value, value: props.value }]
      : props.options;
  const shown = expanded
    ? options
    : options.filter(
        (option, index) =>
          index < COLLAPSED_OPTIONS || option.value === props.value,
      );
  const hidden = options.length - shown.length;
  return (
    <section aria-label={props.label} className="grid gap-1.5 py-4">
      <h3 className="m-0 px-2 font-sans text-sm font-semibold text-dashboard-text">
        {props.label}
      </h3>
      <div aria-label={`Filter by ${props.label.toLowerCase()}`} role="group">
        {[{ label: "All", value: "" }, ...shown].map((option) => (
          <FilterOptionButton
            key={option.value || "all"}
            label={option.label}
            onClick={() => props.onChange(option.value)}
            selected={option.value === props.value}
            // "All" is the default, so only a chosen option stands out.
            subtle={!option.value}
          />
        ))}
      </div>
      {expanded || hidden > 0 ? (
        <button
          className="w-fit cursor-pointer rounded-md border-0 bg-transparent px-2 py-1 font-sans text-xs text-dashboard-text-muted hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-dashboard-focus"
          onClick={() => setExpanded((open) => !open)}
          type="button"
        >
          {expanded ? "Show fewer" : `Show ${hidden} more`}
        </button>
      ) : null}
    </section>
  );
}

function FilterOptionButton(props: {
  label: string;
  onClick(): void;
  selected: boolean;
  subtle: boolean;
}) {
  return (
    <button
      aria-pressed={props.selected}
      className={cn(
        "flex min-h-8 w-full cursor-pointer items-center justify-between gap-3 rounded-md border-0 px-2 py-1 text-left font-sans text-sm transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus",
        !props.selected
          ? "bg-transparent text-dashboard-text-muted hover:bg-dashboard-fill-hover hover:text-dashboard-text"
          : props.subtle
            ? "bg-transparent text-dashboard-text hover:bg-dashboard-fill-hover"
            : "bg-dashboard-accent/[0.12] font-medium text-dashboard-accent-text hover:bg-dashboard-accent/[0.16]",
      )}
      onClick={props.onClick}
      title={props.label}
      type="button"
    >
      <span className="min-w-0 truncate">{props.label}</span>
      {props.selected && !props.subtle ? (
        <Check aria-hidden="true" className="shrink-0" size={14} />
      ) : null}
    </button>
  );
}
