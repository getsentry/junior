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
import { useInboxItemsData } from "../../inbox/queries";
import { inboxItemTitleText } from "../../inbox/inboxItemFormat";

/**
 * Load the open Inbox items linked to a Conversation that the viewer can
 * act on: questions, approvals, reviews, and their own To-dos. Notices and
 * items that the viewer snoozed stay out.
 */
export function useConversationNeedsYou(conversationId: string) {
  const { items, query } = useInboxItemsData({ conversationId });
  return {
    items: items.filter(
      (item) =>
        item.status === "open" &&
        !item.snoozedByViewer &&
        (item.canAct || item.canAnswer) &&
        inboxItemKind(item) !== "FYI",
    ),
    query,
  };
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
  const { items, query } = useConversationNeedsYou(props.conversationId);
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
          highlight={props.highlight && !only}
          item={item}
          key={item.id}
          onOpen={() => setOpenId(item.id)}
        />
      ))}
      <LoadMorePagination
        hasMore={Boolean(query.hasNextPage)}
        loading={query.isFetchingNextPage}
        onLoadMore={() => void query.fetchNextPage()}
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
          {needsYouLabel(kind)} · {formatCompactAge(item.createdAt)}
        </span>
      </span>
      <span className="grid size-5 place-items-center text-dashboard-text-muted">
        <ChevronRight aria-hidden="true" className="size-4" />
      </span>
    </button>
  );
}
