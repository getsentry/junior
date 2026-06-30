/** Render a transcript-shaped loading state for route transitions. */
export function TranscriptLoading() {
  return (
    <div className="grid gap-3">
      <div className="min-h-28 animate-pulse border border-white/10 bg-[#0b0b0b]" />
      <div className="min-h-[4.5rem] animate-pulse border border-white/10 bg-[#0b0b0b]" />
      <div className="min-h-28 animate-pulse border border-white/10 bg-[#0b0b0b]" />
    </div>
  );
}
