import { TranscriptRow, TranscriptRows } from "./TranscriptRows";
import { Skeleton } from "../components/Skeleton";

/** Match the usual transcript rhythm while the selected conversation loads. */
export function TranscriptLoading() {
  return (
    <TranscriptRows aria-busy="true" aria-live="polite" role="status">
      <span className="sr-only">Loading conversation transcript</span>
      <MessageLoading width="w-3/4" />
      <TranscriptRow indent>
        <div className="grid gap-2 py-1">
          <Skeleton className="h-3 w-36 opacity-70" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      </TranscriptRow>
      <MessageLoading width="w-1/2" />
      <MessageLoading width="w-2/3" />
    </TranscriptRows>
  );
}

function MessageLoading(props: { width: string }) {
  return (
    <TranscriptRow>
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
    </TranscriptRow>
  );
}
