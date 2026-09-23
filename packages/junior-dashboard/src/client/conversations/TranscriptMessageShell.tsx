import type { ClipboardEventHandler, ReactNode } from "react";
import { JuniorLogo } from "../components/JuniorLogo";
import { transcriptRoleKind } from "../format";
import { cn } from "../styles";

/** Align messages and delivered attachments with the same actor column. */
export function TranscriptMessageShell(props: {
  actor: string;
  children: ReactNode;
  onCopy?: ClipboardEventHandler<HTMLElement>;
  role: string;
}) {
  const kind = transcriptRoleKind(props.role);
  return (
    <article
      className={transcriptMessageClass(props.role)}
      onCopy={props.onCopy}
    >
      {kind === "assistant" || kind === "user" ? (
        <div
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center md:size-9"
        >
          {kind === "assistant" ? (
            <span className="scale-75">
              <JuniorLogo />
            </span>
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
      <div
        className={cn(
          "grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3",
          kind === "user"
            ? "rounded-xl border border-dashboard-border bg-dashboard-surface-active px-4 py-3"
            : "py-1",
        )}
      >
        {props.children}
      </div>
    </article>
  );
}

/** Keep message avatars and content in consistent transcript columns. */
function transcriptMessageClass(role: string): string {
  const kind = transcriptRoleKind(role);

  return cn(
    "grid min-w-0 gap-3 md:gap-3.5",
    (kind === "assistant" || kind === "user") &&
      "grid-cols-[2rem_minmax(0,1fr)] text-dashboard-text md:grid-cols-[2.25rem_minmax(0,1fr)]",
    kind === "system" &&
      "rounded-xl bg-dashboard-surface-panel px-4 py-3 text-dashboard-text",
    kind === "tool" && "rounded-none px-0 text-dashboard-text-muted",
    kind === "other" && "bg-dashboard-surface-hover text-dashboard-text",
  );
}
