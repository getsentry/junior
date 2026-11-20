import { useEffect, useEffectEvent, useRef } from "react";

import { InlineError } from "../components/InlineError";
import { Button } from "../components/ui/button";

/** A failed read, with Try again. */
export function RetryRow(props: {
  children: string;
  loading: boolean;
  onRetry(): void;
}) {
  return (
    <div className="flex items-center justify-center gap-2 py-3 text-xs">
      <InlineError className="w-auto">{props.children}</InlineError>
      <Button
        className="h-7 px-2 text-xs"
        disabled={props.loading}
        onClick={props.onRetry}
        variant="ghost"
      >
        Try again
      </Button>
    </div>
  );
}

/**
 * The end of a paged list. While it shows, it asks for more, and asks again
 * whenever `progress` changes. After a failed read it shows Try again
 * instead, and asks for nothing until the reader tries again.
 */
export function PageEnd(props: {
  failed: boolean;
  loading: boolean;
  more: boolean;
  onRetry(): void;
  onShow(): void;
  progress: string;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  const onShow = useEffectEvent(props.onShow);
  const active = props.more && !props.failed;
  // A new observer reports at once, so the list keeps loading while its
  // end shows.
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !active) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onShow();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [active, props.progress]);
  if (props.failed)
    return (
      <RetryRow loading={props.loading} onRetry={props.onRetry}>
        Could not load more.
      </RetryRow>
    );
  if (!props.more) return null;
  return (
    <div
      className="py-3 text-center font-sans text-xs text-dashboard-text-muted"
      ref={sentinel}
      role="status"
    >
      {props.loading ? "Loading more…" : null}
    </div>
  );
}
