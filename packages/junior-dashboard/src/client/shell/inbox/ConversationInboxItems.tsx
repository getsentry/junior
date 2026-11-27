import { ChevronRight, Inbox } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { InboxItemPayload } from "@sentry/junior/api/schema";

import { LoadMorePagination } from "../../components/Pagination";
import { cn } from "../../styles";
import { useMobileLayout } from "../../layoutMedia";
import { formatCompactAge } from "../../time";
import { InboxItemDialog, InboxItemSheet } from "../../inbox/InboxItemSheet";
import { AskKindIcon, askIcon } from "../../inbox/askKind";
import { inboxItemKind } from "../../inbox/inboxModel";
import { useDashboardCoreData } from "../../api";
import { useConversationChildAgents } from "../../conversations/ConversationChildAgents";
import { useInboxItemsData } from "../../inbox/queries";
import { inboxItemTitleText } from "../../inbox/inboxItemFormat";

/**
 * Load the open Inbox items that the viewer can act on for a Conversation:
 * questions, approvals, reviews, and their own To-dos. Items of its child
 * Conversations count too, since they block its work: on a root, every item
 * of its tree; on a child, the items of its own child agents. Notices and
 * items that the viewer snoozed stay out.
 */
export function useConversationNeedsYou(conversationId: string) {
  // Items that wait on the viewer page first, so the first page holds them.
  const { items, query } = useInboxItemsData({
    conversationId,
    forViewer: true,
    sort: "waiting",
  });
  // The Inbox already reads the viewer's waiting items, so the child items
  // come from that read, with no read of their own.
  const signedIn = Boolean(useDashboardCoreData().data?.me.user.email);
  const { items: waiting, query: waitingQuery } = useInboxItemsData({
    enabled: signedIn,
    forViewer: true,
    sort: "waiting",
  });
  const childIds = new Set(
    (useConversationChildAgents(conversationId).data?.agents ?? []).map(
      (child) => child.conversationId,
    ),
  );
  const ids = new Set(items.map((item) => item.id));
  const fromChildren = waiting.filter(
    (item) =>
      !ids.has(item.id) &&
      item.owner.kind === "conversation" &&
      item.owner.id !== conversationId &&
      (item.rootConversationId === conversationId ||
        childIds.has(item.owner.id) ||
        item.conversationIds.some((id) => childIds.has(id))),
  );
  // The waiting read pages what needs the viewer first, so once its last
  // item does not need them, its later pages hold no child's ask.
  const lastWaiting = waiting.at(-1);
  const moreWaiting = Boolean(
    waitingQuery.hasNextPage && lastWaiting && needsViewer(lastWaiting),
  );
  return {
    items: [...items, ...fromChildren].filter(needsViewer),
    // Load more pages both reads, so a child's ask on a later page shows.
    hasMore: Boolean(query.hasNextPage) || moreWaiting,
    loadingMore: query.isFetchingNextPage || waitingQuery.isFetchingNextPage,
    loadMore: () => {
      if (query.hasNextPage) void query.fetchNextPage();
      if (moreWaiting) void waitingQuery.fetchNextPage();
    },
    query,
  };
}

/** True for an open, unsnoozed ask that the viewer can act on. */
function needsViewer(item: InboxItemPayload): boolean {
  return (
    item.status === "open" &&
    !item.snoozedByViewer &&
    (item.canAct || item.canAnswer) &&
    inboxItemKind(item) !== "FYI"
  );
}

/** Name the kind of ask for the viewer, such as "Question for you". */
function needsYouLabel(kind: string): string {
  return kind === "Question" || kind === "Approval" ? `${kind} for you` : kind;
}

/**
 * Lead Conversation details with what needs the viewer: one card per open
 * Inbox item that they can act on. A card opens the item in a dialog, or in
 * a sheet on a phone. `highlight` comes from a sidebar review link: it opens
 * the only item, or marks the cards when there are more.
 */
export function ConversationInboxItems(props: {
  conversationId: string;
  highlight: boolean;
}) {
  const { hasMore, items, loadMore, loadingMore } = useConversationNeedsYou(
    props.conversationId,
  );
  const [openId, setOpenId] = useState<string>();
  const sectionRef = useRef<HTMLElement>(null);
  const mobile = useMobileLayout();
  const only = items.length === 1 ? items[0]?.id : undefined;
  const shown = items.length > 0;
  // Details can already be open when a sidebar review link highlights it.
  useEffect(() => {
    if (!props.highlight || !shown) return;
    if (only) setOpenId(only);
    else sectionRef.current?.scrollIntoView({ block: "nearest" });
  }, [props.highlight, shown, only]);
  if (!shown) return null;
  const open = items.find((item) => item.id === openId);
  const close = () => setOpenId(undefined);
  return (
    <section
      aria-label="Needs you"
      className="grid min-w-0 gap-1"
      ref={sectionRef}
    >
      {items.map((item) => (
        <NeedsYouCard
          child={
            item.owner.id === props.conversationId
              ? undefined
              : item.addedByLabel
          }
          highlight={props.highlight && !only}
          item={item}
          key={item.id}
          onOpen={() => setOpenId(item.id)}
        />
      ))}
      <LoadMorePagination
        hasMore={hasMore}
        loading={loadingMore}
        onLoadMore={loadMore}
      />
      {open ? (
        mobile ? (
          <InboxItemSheet item={open} key={open.id} onClose={close} />
        ) : (
          <InboxItemDialog item={open} key={open.id} onClose={close} />
        )
      ) : null}
    </section>
  );
}

function NeedsYouCard(props: {
  /** The child Conversation that added the item, by its label. */
  child: string | undefined;
  highlight: boolean;
  item: InboxItemPayload;
  onOpen(): void;
}) {
  const { item } = props;
  const kind = inboxItemKind(item);
  return (
    <button
      className={cn(
        "group grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2.5 rounded-md bg-dashboard-fill-soft px-2 py-2 text-left font-sans transition-colors hover:bg-dashboard-fill-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus motion-reduce:transition-none",
        props.highlight && "ring-2 ring-dashboard-focus/50",
      )}
      onClick={props.onOpen}
      type="button"
    >
      {/* The kind's icon, as the Inbox pills show it, at the row size. */}
      <span className="grid size-5 shrink-0 place-items-center text-dashboard-text-muted [&_svg]:size-4">
        {askIcon(kind) ? (
          <AskKindIcon kind={kind} />
        ) : (
          <Inbox aria-hidden="true" />
        )}
      </span>
      <span className="grid min-w-0 gap-1">
        <span className="min-w-0 break-words text-sm font-medium leading-5 text-dashboard-text">
          {inboxItemTitleText(item)}
        </span>
        <span className="text-xs leading-4 text-dashboard-text-muted">
          {needsYouLabel(kind)} · {props.child ? `${props.child} · ` : null}
          {formatCompactAge(item.createdAt)}
        </span>
      </span>
      <span className="grid size-5 place-items-center text-dashboard-text-muted">
        <ChevronRight aria-hidden="true" className="size-4" />
      </span>
    </button>
  );
}
