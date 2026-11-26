import { ChevronRight, CircleAlert } from "lucide-react";

import { Button } from "../components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import { Skeleton } from "../components/ui/skeleton";
import { conversationPath } from "../conversations/conversationRoutes";
import {
  attentionGroups,
  type AttentionGroup,
} from "../conversations/conversationSections";
import {
  ConversationStateIcon,
  conversationDisplayState,
} from "../conversations/ConversationStateIcon";
import {
  DetailsCard,
  DetailsRow,
  DetailsRowLine,
} from "../conversations/DetailsList";
import { DisplayText } from "../display-text/DisplayText";
import { buildConversations, conversationDisplayTitle } from "../format";
import { cn, dashboardDisclosureChevronClass } from "../styles";
import { formatCompactAge } from "../time";
import type { Conversation } from "../types";
import { useSpaceConversationsData } from "./queries";

const GROUP_LABELS: Record<AttentionGroup, string> = {
  done: "Done",
  needs_you: "Needs you",
  waiting: "Waiting",
  working: "Working",
};

const GROUP_HEADING_CLASS =
  "m-0 flex items-center gap-1 px-1.5 pt-1.5 pb-0.5 font-sans text-xs font-medium text-dashboard-text-muted";

/** A Space's Threads, grouped by what they need from the viewer. */
export function SpaceThreads(props: { spaceId: string }) {
  const feed = useSpaceConversationsData(props.spaceId);
  const threads = buildConversations(feed.data?.conversations ?? []);
  return (
    <DetailsCard count={threads.length} label="Threads" title="Threads">
      {/* A failed refresh keeps the Threads that loaded. */}
      {feed.data ? (
        threads.length === 0 ? (
          <p className="m-0">No Threads in this Space yet.</p>
        ) : (
          <ThreadGroups threads={threads} />
        )
      ) : feed.error ? (
        <p className="m-0">Threads are unavailable.</p>
      ) : (
        <Skeleton className="h-4 w-3/5" />
      )}
    </DetailsCard>
  );
}

/**
 * Show Threads in `attentionGroups` order, each group under its label and
 * count. Done starts collapsed: it needs nothing, and it grows the most.
 */
export function ThreadGroups(props: { threads: Conversation[] }) {
  return (
    <div className="-mx-1.5 -mb-1.5 -mt-1 grid gap-1">
      {attentionGroups(props.threads).map(({ conversations, group }) => {
        const label = `${GROUP_LABELS[group]} · ${conversations.length}`;
        if (group === "done") {
          return (
            <Collapsible key={group} render={<section aria-label="Done" />}>
              <h4 className="m-0">
                <CollapsibleTrigger
                  render={
                    <Button
                      className={cn(
                        GROUP_HEADING_CLASS,
                        "group rounded-md hover:text-dashboard-text",
                      )}
                      size="bare"
                      variant="ghost"
                    />
                  }
                >
                  {label}
                  <ChevronRight
                    aria-hidden="true"
                    className={dashboardDisclosureChevronClass}
                  />
                </CollapsibleTrigger>
              </h4>
              <CollapsibleContent>
                <ThreadList threads={conversations} />
              </CollapsibleContent>
            </Collapsible>
          );
        }
        return (
          <section aria-label={GROUP_LABELS[group]} key={group}>
            <h4 className={GROUP_HEADING_CLASS}>{label}</h4>
            <ThreadList threads={conversations} />
          </section>
        );
      })}
    </div>
  );
}

function ThreadList(props: { threads: Conversation[] }) {
  return (
    <ul className="m-0 grid list-none gap-0.5 p-0">
      {props.threads.map((thread) => {
        const subtitle = thread.summary ?? thread.activityPreview?.text;
        return (
          <li key={thread.id}>
            <DetailsRow
              icon={<ThreadStateIcon thread={thread} />}
              meta={formatCompactAge(thread.lastMessageAt ?? thread.lastSeenAt)}
              title={conversationDisplayTitle(thread)}
              to={conversationPath(thread.id)}
            >
              {subtitle ? (
                <DetailsRowLine className="truncate">
                  <DisplayText
                    inline
                    links={false}
                    mentions={
                      thread.summary
                        ? undefined
                        : thread.activityPreview?.mentions
                    }
                    text={subtitle}
                  />
                </DetailsRowLine>
              ) : null}
            </DetailsRow>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A row's state icon, as In flight shows it. A failed latest Turn shows
 * unless the tree waits on the viewer. A done row keeps a blank, so titles
 * line up.
 */
function ThreadStateIcon(props: { thread: Conversation }) {
  const state = conversationDisplayState(props.thread);
  if (state !== "needs_you" && props.thread.latestTurnFailed) {
    return (
      <span className="inline-flex size-3.5 shrink-0" title="Failed">
        <CircleAlert
          aria-label="Failed"
          className="size-full text-dashboard-text-muted"
          role="img"
        />
      </span>
    );
  }
  if (!state) return <span aria-hidden="true" className="size-3.5" />;
  return <ConversationStateIcon state={state} />;
}
