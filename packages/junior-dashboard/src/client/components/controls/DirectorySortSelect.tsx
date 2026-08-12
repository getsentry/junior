export type DirectorySortOption = {
  label: string;
  value: string;
};

/** Render a native directory sort control that follows the dashboard color scheme. */
export function DirectorySortSelect(props: {
  ariaLabel: string;
  onChange(value: string): void;
  options: readonly DirectorySortOption[];
  value: string;
}) {
  return (
    <label className="grid h-9 min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center overflow-hidden rounded-lg border border-dashboard-border-strong bg-dashboard-fill-soft transition-colors hover:border-dashboard-border-emphasis focus-within:border-amber-500/35 focus-within:ring-1 focus-within:ring-amber-500/15">
      <span className="flex h-full items-center border-r border-dashboard-border px-2 font-mono text-xs uppercase tracking-[0.12em] text-dashboard-text-muted">
        Sort
      </span>
      <select
        aria-label={props.ariaLabel}
        className="h-full min-w-0 bg-dashboard-control px-2 font-mono text-xs text-dashboard-text-muted outline-none [color-scheme:var(--dashboard-color-scheme,dark)]"
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      >
        {props.options.map((option) => (
          <option
            className="bg-dashboard-control text-dashboard-text"
            key={option.value}
            value={option.value}
          >
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
