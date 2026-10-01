import type { ClipboardEventHandler, ReactNode } from "react";
import { transcriptRoleKind } from "../format";
import { cn } from "../styles";

/** Align message text and attachments beside their avatars. */
export function TranscriptMessageShell(props: {
  actor: string;
  children: ReactNode;
  onCopy?: ClipboardEventHandler<HTMLElement>;
  role: string;
}) {
  const kind = transcriptRoleKind(props.role);
  const hasAvatar = kind === "assistant" || kind === "user";
  return (
    <article
      className={cn(
        "group/message grid min-w-0 gap-3",
        hasAvatar && "grid-cols-[2rem_minmax(0,1fr)] text-dashboard-text",
        kind === "system" &&
          "rounded-xl bg-dashboard-surface-panel px-4 py-3 text-dashboard-text",
        kind === "tool" && "rounded-none px-0 text-dashboard-text-muted",
        kind === "other" && "bg-dashboard-surface-hover text-dashboard-text",
      )}
      onCopy={props.onCopy}
    >
      {hasAvatar ? (
        <div
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center"
        >
          {kind === "assistant" ? (
            <img
              alt=""
              className="size-8 object-contain"
              draggable={false}
              src="/_junior/dashboard/avatar.png"
            />
          ) : (
            <span className="grid size-8 place-items-center rounded-full bg-violet-300 font-sans text-xs font-semibold text-dashboard-text-inverse">
              {props.actor
                .split(/\s+/)
                .map((word) => word[0])
                .slice(0, 2)
                .join("")
                .toUpperCase()}
            </span>
          )}
        </div>
      ) : null}
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 py-1">
        {props.children}
      </div>
    </article>
  );
}
