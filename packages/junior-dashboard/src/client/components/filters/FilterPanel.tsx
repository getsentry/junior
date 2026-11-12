import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, X } from "lucide-react";

import { BottomSheet } from "../BottomSheet";
import { useDetailsPanel } from "../DetailsPanel";
import { MatchedLabel } from "../MatchedLabel";
import { quickOpenMatch } from "../quickOpenMatch";
import { SearchInput } from "../SearchInput";
import { Button } from "../ui/button";
import { cn } from "../../styles";
import { SectionTitle } from "../layout/SectionTitle";

/** One choice in a `FilterOptions` list. */
export type FilterOption = { label: string; value: string };

// Long option lists show this many options and a search box.
const SHOWN_OPTIONS = 6;

/**
 * Lay out a search bar and a list with the open `FilterPanel` on the right
 * of both. The panel takes room from them, so they narrow instead of being
 * covered.
 */
export function FilteredList(props: {
  children: ReactNode;
  /** The open `FilterPanel`, or null while filters are closed. */
  filters: ReactNode;
  /** The `FilterToolbar` above the list. */
  toolbar: ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid min-w-0 items-start gap-6",
        props.filters ? "xl:grid-cols-[minmax(0,1fr)_16rem]" : undefined,
      )}
    >
      <div className="grid min-w-0 gap-6">
        {props.toolbar}
        {props.children}
      </div>
      {props.filters}
    </div>
  );
}

/**
 * Edit page filters in a column beside the list on wide screens, and in a
 * modal sheet elsewhere. Put one `FilterOptions` in it per filter. Render it
 * as the `filters` of a `FilteredList`.
 */
export function FilterPanel(props: {
  children: ReactNode;
  /** Clears every filter. Shown only while a filter is set. */
  onClear?(): void;
  onClose(): void;
}) {
  const { onClose } = props;
  const beside = useDetailsPanel();
  const closeRef = useRef<HTMLButtonElement>(null);
  // The toggle that opened the panel hides beside it, so focus moves here.
  useEffect(() => {
    if (beside) closeRef.current?.focus();
  }, [beside]);
  const clear = props.onClear ? (
    <Button onClick={props.onClear} variant="ghost">
      Clear all
    </Button>
  ) : null;
  const options = (
    <div className="grid divide-y divide-dashboard-border-subtle px-3">
      {props.children}
    </div>
  );
  if (!beside) {
    return (
      <BottomSheet label="Filters" onClose={onClose} title="Filters">
        <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto]">
          <div className="min-h-0 overflow-y-auto">{options}</div>
          {clear ? (
            <div className="flex justify-end border-t border-dashboard-border px-4 py-2">
              {clear}
            </div>
          ) : null}
        </div>
      </BottomSheet>
    );
  }
  return (
    <aside
      aria-label="Filters"
      className="sticky top-4 grid max-h-[calc(100dvh-2rem)] min-h-0 grid-rows-[auto_minmax(0,1fr)] rounded-lg border border-dashboard-border-subtle bg-dashboard-surface-panel"
    >
      <header className="flex items-center justify-between gap-2 border-b border-dashboard-border-subtle py-1.5 pl-4 pr-1.5">
        <h2 className="m-0 font-display text-base font-medium text-dashboard-text">
          Filters
        </h2>
        <div className="flex items-center gap-0.5">
          {clear}
          <Button
            variant="ghost"
            aria-label="Close filters"
            onClick={onClose}
            ref={closeRef}
            size="icon"
          >
            <X aria-hidden="true" size={15} />
          </Button>
        </div>
      </header>
      <div className="thin-scrollbar min-h-0 overflow-y-auto overscroll-contain">
        {options}
      </div>
    </aside>
  );
}

/**
 * One filter as a list of pressable options under a heading, so every
 * choice is visible without a menu. "All" (value `""`) clears it. A long
 * list shows its first options and the selected one, and a search box
 * finds the rest.
 */
export function FilterOptions(props: {
  label: string;
  onChange(value: string): void;
  options: readonly FilterOption[];
  value: string;
}) {
  const [search, setSearch] = useState("");
  // A shared URL can select a value that the loaded options do not list.
  const options =
    props.value && !props.options.some((option) => option.value === props.value)
      ? [...props.options, { label: props.value, value: props.value }]
      : props.options;
  const searchable = options.length > SHOWN_OPTIONS;
  const query = search.trim();
  // Rank like the other dashboard pickers, best match first.
  const rows = query
    ? options
        .flatMap((option) => {
          const match = quickOpenMatch(option.label, query);
          return match
            ? [{ option, matches: match.indices, score: match.score }]
            : [];
        })
        .sort((left, right) => right.score - left.score)
    : options.map((option) => ({ option, matches: undefined }));
  const top = rows.slice(0, SHOWN_OPTIONS);
  const selected = options.find((option) => option.value === props.value);
  const shown =
    selected && !top.some((row) => row.option === selected)
      ? [...top, { option: selected, matches: undefined }]
      : top;
  return (
    <section aria-label={props.label} className="grid gap-1.5 py-4">
      <div className="px-2">
        <SectionTitle>{props.label}</SectionTitle>
      </div>
      {searchable ? (
        <SearchInput
          label={`Search ${props.label.toLowerCase()} options`}
          onChange={setSearch}
          placeholder={`Find ${props.label.toLowerCase()}`}
          value={search}
        />
      ) : null}
      <div aria-label={`Filter by ${props.label.toLowerCase()}`} role="group">
        {[
          { option: { label: "All", value: "" }, matches: undefined },
          ...shown,
        ].map(({ option, matches }) => (
          <FilterOptionButton
            key={option.value || "all"}
            label={option.label}
            matches={matches}
            onClick={() => props.onChange(option.value)}
            selected={option.value === props.value}
            // "All" is the default, so only a chosen option stands out.
            subtle={!option.value}
          />
        ))}
      </div>
      {query && rows.length === 0 ? (
        <p className="m-0 px-2 text-xs text-dashboard-text-muted">
          No matches.
        </p>
      ) : null}
    </section>
  );
}

function FilterOptionButton(props: {
  label: string;
  matches?: number[];
  onClick(): void;
  selected: boolean;
  subtle: boolean;
}) {
  return (
    <Button
      aria-pressed={props.selected}
      className={cn(
        "flex min-h-8 w-full items-center justify-between gap-3 rounded-md px-2 py-1 text-left text-sm hover:bg-dashboard-fill-hover focus-visible:-outline-offset-2",
        props.selected &&
          (props.subtle
            ? "text-dashboard-text"
            : "bg-dashboard-accent/[0.12] font-medium text-dashboard-accent-text hover:bg-dashboard-accent/[0.16] hover:text-dashboard-accent-text"),
      )}
      onClick={props.onClick}
      size="bare"
      title={props.label}
      variant="ghost"
    >
      <span className="min-w-0 truncate">
        <MatchedLabel label={props.label} matches={props.matches} />
      </span>
      {props.selected && !props.subtle ? (
        <Check aria-hidden="true" className="shrink-0" size={14} />
      ) : null}
    </Button>
  );
}
