import type { ReactNode } from "react";

/** Render the compact source, owner, and runtime line below a conversation title. */
export function ConversationHeaderMeta(props: {
  /** Link to the Automation that started this run, when it is one. */
  automation?: ReactNode;
  identity: ReactNode;
  stats: ReactNode;
}) {
  if (!props.automation && !props.identity && !props.stats) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
      {props.automation ? (
        <span className="min-w-0 max-w-full">{props.automation}</span>
      ) : null}
      {props.automation && (props.identity || props.stats) ? (
        <span className="text-dashboard-text-muted">·</span>
      ) : null}
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
