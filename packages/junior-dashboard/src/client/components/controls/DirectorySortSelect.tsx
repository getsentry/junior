import { NativeSelect } from "../ui/native-select";

export type DirectorySortOption = {
  label: string;
  value: string;
};

/** Keep directory sorting consistent with the dashboard's shared select. */
export function DirectorySortSelect(props: {
  ariaLabel: string;
  onChange(value: string): void;
  options: readonly DirectorySortOption[];
  value: string;
}) {
  return (
    <label className="grid h-9 min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center overflow-hidden rounded-lg border border-dashboard-border-strong bg-dashboard-fill-faint transition-colors hover:border-dashboard-border-emphasis focus-within:border-amber-500/35 focus-within:ring-1 focus-within:ring-amber-500/15">
      <span className="flex h-full items-center border-r border-dashboard-border-subtle px-2 font-sans font-medium text-xs text-dashboard-text-muted">
        Sort
      </span>
      <NativeSelect
        aria-label={props.ariaLabel}
        variant="sort"
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
      </NativeSelect>
    </label>
  );
}
