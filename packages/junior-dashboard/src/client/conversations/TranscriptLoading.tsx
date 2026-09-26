import { Skeleton } from "../components/Skeleton";

/** Match the usual transcript rhythm while the selected conversation loads. */
export function TranscriptLoading() {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className="grid gap-4"
      role="status"
    >
      <span className="sr-only">Loading conversation transcript</span>
      <MessageLoading width="w-3/4" />
      <div className="ml-11 grid gap-2 py-1">
        <Skeleton className="h-3 w-36 opacity-70" />
        <Skeleton className="h-3 w-1/2" />
      </div>
      <MessageLoading width="w-1/2" />
      <MessageLoading width="w-2/3" />
    </div>
  );
}

function MessageLoading(props: { width: string }) {
  return (
    <div className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3">
      <Skeleton className="size-8 rounded-full" />
      <div className="grid gap-2 pt-1">
        <div className="flex h-6 items-center">
          <Skeleton className="h-3 w-24 opacity-70" />
        </div>
        <Skeleton className={`h-4 max-w-xl ${props.width}`} />
        <Skeleton className="h-4 w-1/2 max-w-lg" />
      </div>
    </div>
  );
}
