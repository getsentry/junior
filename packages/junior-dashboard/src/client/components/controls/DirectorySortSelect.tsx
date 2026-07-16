export type DirectorySortOption = {
  label: string;
  value: string;
};

/** Render a native directory sort control with an explicit dark color scheme. */
export function DirectorySortSelect(props: {
  ariaLabel: string;
  onChange(value: string): void;
  options: readonly DirectorySortOption[];
  value: string;
}) {
  return (
    <label className="grid h-9 min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center overflow-hidden rounded-lg border border-white/10 bg-white/[0.025] transition-colors hover:border-white/20 focus-within:border-amber-500/35 focus-within:ring-1 focus-within:ring-amber-500/15">
      <span className="flex h-full items-center border-r border-white/[0.07] px-2 font-mono text-[0.62rem] uppercase tracking-[0.12em] text-white/50">
        Sort
      </span>
      <select
        aria-label={props.ariaLabel}
        className="h-full min-w-0 bg-[#111114] px-2 font-mono text-[0.72rem] text-white/70 outline-none [color-scheme:dark]"
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      >
        {props.options.map((option) => (
          <option
            className="bg-[#111114] text-white/80"
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
