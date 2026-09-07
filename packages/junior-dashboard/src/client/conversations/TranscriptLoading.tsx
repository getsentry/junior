import { Skeleton } from "../components/Skeleton";

/** Match the usual transcript rhythm while the selected conversation loads. */
export function TranscriptLoading() {
  return (
    <div aria-hidden="true" className="grid gap-6 py-2">
      <MessageLoading width="w-3/4" />
      <div className="grid gap-2 border-l border-dashboard-border-subtle py-1 pl-4">
        <Skeleton className="h-3 w-36 opacity-70" />
        <Skeleton className="h-3 w-1/2" />
      </div>
      <div className="grid justify-items-end gap-2">
        <Skeleton className="h-3 w-24 opacity-70" />
        <Skeleton className="h-4 w-56" />
      </div>
      <MessageLoading width="w-2/3" />
    </div>
  );
}

function MessageLoading(props: { width: string }) {
  return (
    <div className="grid gap-2">
      <Skeleton className="h-3 w-24 opacity-70" />
      <Skeleton className={`h-4 max-w-xl ${props.width}`} />
      <Skeleton className="h-4 w-1/2 max-w-lg" />
    </div>
  );
}
