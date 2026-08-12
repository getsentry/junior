/** Render a transcript-shaped loading state for route transitions. */
export function TranscriptLoading() {
  return (
    <div className="grid gap-3">
      <div className="min-h-28 animate-pulse rounded-lg border border-dashboard-border-strong bg-dashboard-surface-raised" />
      <div className="min-h-[4.5rem] animate-pulse rounded-lg border border-dashboard-border-strong bg-dashboard-surface-raised" />
      <div className="min-h-28 animate-pulse rounded-lg border border-dashboard-border-strong bg-dashboard-surface-raised" />
    </div>
  );
}
