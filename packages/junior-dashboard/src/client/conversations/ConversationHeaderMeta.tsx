import type { ReactNode } from "react";

/** Render the compact owner and runtime line below a conversation title. */
export function ConversationHeaderMeta(props: {
  identity: ReactNode;
  stats: ReactNode;
}) {
  if (!props.identity && !props.stats) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
      {props.identity ? (
        <span className="min-w-0 max-w-full truncate">{props.identity}</span>
      ) : null}
      {props.identity && props.stats ? (
        <span className="text-dashboard-text-muted">·</span>
      ) : null}
      {props.stats ? <span className="min-w-0">{props.stats}</span> : null}
    </div>
  );
}
