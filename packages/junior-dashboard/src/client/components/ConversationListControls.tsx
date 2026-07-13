import { Search } from "lucide-react";

import type { ConversationListFilterOption } from "../format";
import { cn } from "../styles";
import { Button } from "./Button";

/** Render the dashboard's compact conversation search input. */
export function ConversationSearchInput(props: {
  className?: string;
  label: string;
  onChange(value: string): void;
  placeholder: string;
  value: string;
}) {
  return (
    <div className={cn("relative min-w-0", props.className)}>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[#555]"
        size={13}
        strokeWidth={2.5}
      />
      <input
        aria-label={props.label}
        className="h-9 w-full rounded-md border border-white/15 bg-[#0b0b0b] pl-8 pr-3 text-[0.82rem] text-[#d6d6d6] outline-none transition-colors placeholder:text-[#555] hover:border-white/30 focus:border-[#beaaff]/45 focus:ring-1 focus:ring-[#beaaff]/20"
        placeholder={props.placeholder}
        type="search"
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      />
    </div>
  );
}

/** Render a compact inline select for conversation list facets. */
export function ConversationFilterSelect(props: {
  allLabel: string;
  label: string;
  onChange(value: string): void;
  options: ConversationListFilterOption[];
  value: string;
}) {
  return (
    <label className="grid h-9 min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center overflow-hidden rounded-md border border-white/15 bg-[#0b0b0b] transition-colors hover:border-white/30 focus-within:border-[#beaaff]/45 focus-within:ring-1 focus-within:ring-[#beaaff]/20">
      <span className="flex h-full items-center border-r border-white/10 px-2 text-[0.68rem] font-semibold uppercase leading-none text-[#777]">
        {props.label}
      </span>
      <select
        aria-label={props.label}
        className="h-full min-w-0 bg-transparent px-2 text-[0.82rem] font-semibold text-[#d6d6d6] outline-none"
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      >
        <option value="">{props.allLabel}</option>
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Render the conversation list search and facet controls as one compact toolbar. */
export function ConversationListToolbar(props: {
  query: string;
  actor: string;
  actorOptions: ConversationListFilterOption[];
  location: string;
  locationOptions: ConversationListFilterOption[];
  source: string;
  sourceOptions: ConversationListFilterOption[];
  onQueryChange(value: string): void;
  onActorChange(value: string): void;
  onLocationChange(value: string): void;
  onSourceChange(value: string): void;
  onClear?(): void;
}) {
  const filtered = Boolean(
    props.query.trim() || props.actor || props.location || props.source,
  );
  return (
    <div className="border-b border-white/10 bg-[#050505] px-3 py-3">
      <div className="grid min-w-0 gap-2 lg:grid-cols-[minmax(13rem,1fr)_minmax(9rem,12rem)_minmax(11rem,15rem)_minmax(11rem,15rem)_auto]">
        <ConversationSearchInput
          label="Search conversations"
          placeholder="Search title, email, channel, id..."
          value={props.query}
          onChange={props.onQueryChange}
        />
        <ConversationFilterSelect
          allLabel="All sources"
          label="Source"
          options={props.sourceOptions}
          value={props.source}
          onChange={props.onSourceChange}
        />
        <ConversationFilterSelect
          allLabel="All locations"
          label="Location"
          options={props.locationOptions}
          value={props.location}
          onChange={props.onLocationChange}
        />
        <ConversationFilterSelect
          allLabel="All actors"
          label="Actor"
          options={props.actorOptions}
          value={props.actor}
          onChange={props.onActorChange}
        />
        {filtered && props.onClear ? (
          <Button
            className="h-9 justify-center md:w-auto"
            onClick={props.onClear}
          >
            Clear
          </Button>
        ) : null}
      </div>
    </div>
  );
}
