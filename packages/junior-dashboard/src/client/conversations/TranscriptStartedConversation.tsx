import { ChevronRight, Eye } from "lucide-react";
import { useContext } from "react";
import { Link } from "react-router";
import * as z from "zod";

import { Button, buttonVariants } from "../components/ui/button";
import { LeadPage } from "../lead/leadPage";
import { leadWorkState } from "../lead/leadWork";
import { LeadWorkLabel, LeadWorkTile } from "../lead/LeadWorkStatus";
import { displayPlainText } from "../display-text/plainText";
import { cn } from "../styles";
import { formatCompactAge } from "../time";
import { linkLabel, referenceText } from "./composerReferences";
import { usePrefetchConversation } from "./conversationPrefetch";
import { conversationPath, conversationUrl } from "./conversationRoutes";
import { transcriptColumnsClass } from "./TranscriptRows";

const startConversationInputSchema = z.object({ title: z.string().min(1) });

/**
 * Show a Conversation that a Lead started as a card, not a tool call: its
 * state, title, latest Brief, and whether the Lead watches it. A card that
 * needs the viewer or failed offers to open it or to message it.
 */
export function TranscriptStartedConversation(props: {
  conversationId: string;
  /** Input of the `startConversation` call. */
  input: unknown;
  timestamp?: number | undefined;
}) {
  const id = props.conversationId;
  const lead = useContext(LeadPage);
  const watched = lead?.watchedIds.has(id) ?? false;
  const prefetch = usePrefetchConversation(id);
  // A started Conversation is a root of the person, so it is a feed row. The
  // row can be past the loaded feed pages. Then only a Review item tells its
  // state, and the card shows none rather than a wrong one.
  const conversation = lead?.conversations.get(id);
  const waiting = lead?.waiting.get(id);
  const state = conversation
    ? leadWorkState(conversation, waiting)
    : waiting
      ? "needs_you"
      : undefined;
  const input = startConversationInputSchema.safeParse(props.input);
  const title =
    conversation?.displayTitle ??
    (input.success ? input.data.title : "Conversation");
  const activityAt =
    conversation?.lastSeenAt ??
    (typeof props.timestamp === "number"
      ? new Date(props.timestamp).toISOString()
      : undefined);
  const summary = conversation?.brief?.summary;
  const actionable = state === "needs_you" || state === "failed";
  return (
    <div className={cn("grid min-w-0", transcriptColumnsClass)}>
      <span aria-hidden="true" />
      <article
        aria-label={title}
        className={cn(
          "min-w-0 rounded-lg border bg-dashboard-surface-panel",
          state === "needs_you"
            ? "border-amber-400/30"
            : "border-dashboard-border-subtle",
        )}
      >
        <Link
          {...prefetch}
          className="group/started flex min-w-0 items-start gap-3 rounded-lg px-3 py-2.5 text-inherit no-underline transition-colors hover:bg-dashboard-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus"
          to={conversationPath(id)}
        >
          <LeadWorkTile state={state} />
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <span className="min-w-0 flex-1 truncate font-sans text-base font-semibold text-dashboard-text max-md:basis-full">
                {title}
              </span>
              <span className="flex shrink-0 items-center gap-3">
                {state ? <LeadWorkLabel state={state} /> : null}
                {watched ? (
                  <span className="inline-flex items-center gap-1 font-sans text-xs text-dashboard-text-muted">
                    <Eye
                      aria-hidden="true"
                      className="size-3.5"
                      strokeWidth={2}
                    />
                    Watching
                  </span>
                ) : null}
                {activityAt ? (
                  <span className="font-sans text-xs tabular-nums text-dashboard-text-faint">
                    {formatCompactAge(activityAt)}
                  </span>
                ) : null}
                <ChevronRight
                  aria-hidden="true"
                  className="size-4 text-dashboard-text-faint transition-colors group-hover/started:text-dashboard-text"
                />
              </span>
            </span>
            {summary ? (
              <span className="line-clamp-2 font-sans text-sm text-dashboard-text-muted">
                {displayPlainText(summary)}
              </span>
            ) : null}
          </span>
        </Link>
        {actionable ? (
          <div className="flex flex-wrap gap-2 px-3 pb-3 pl-[3.375rem]">
            <Link
              className={buttonVariants({ variant: "default" })}
              to={conversationPath(id, { reviewItems: Boolean(waiting) })}
            >
              {/* A sign-in wait has no Review item to approve. */}
              {waiting ? "Open to approve" : "Open"}
            </Link>
            {lead ? (
              <Button
                onClick={() =>
                  lead.prefill(
                    referenceText({
                      kind: "conversation",
                      title: linkLabel(title) || id,
                      url: conversationUrl(id),
                    }),
                  )
                }
                variant="outline"
              >
                Message it
              </Button>
            ) : null}
          </div>
        ) : null}
      </article>
    </div>
  );
}
