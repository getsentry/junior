/** Preserve directory table geometry while a new client-side order renders. */
export function DirectoryRowsSkeleton(props: { wideRuntime?: boolean }) {
  const gridColumns = props.wideRuntime
    ? "grid-cols-[minmax(14rem,1fr)_repeat(2,minmax(5rem,auto))_minmax(8rem,auto)] max-md:grid-cols-3"
    : "grid-cols-[minmax(14rem,1fr)_repeat(3,minmax(5rem,auto))] max-md:grid-cols-3";

  return (
    <div
      aria-label="Loading sorted results"
      className="min-w-0 animate-pulse"
      role="status"
    >
      {Array.from({ length: 5 }, (_, index) => (
        <div
          aria-hidden="true"
          className={`grid min-w-0 ${gridColumns} items-center gap-4 border-b border-white/[0.055] px-4 py-3.5 last:border-b-0 max-md:gap-x-3 max-md:gap-y-4`}
          key={index}
        >
          <div className="flex min-w-0 items-center gap-3 max-md:col-span-3">
            <span className="size-9 shrink-0 rounded bg-white/[0.07]" />
            <div className="grid min-w-0 flex-1 gap-2">
              <span className="h-3.5 w-2/5 rounded bg-white/[0.08]" />
              <span className="h-2.5 w-3/5 rounded bg-white/[0.045]" />
            </div>
          </div>
          {[0, 1, 2].map((metric) => (
            <span
              className="h-4 w-10 justify-self-end rounded bg-white/[0.06]"
              key={metric}
            />
          ))}
        </div>
      ))}
      <span className="sr-only">Loading sorted results</span>
    </div>
  );
}
