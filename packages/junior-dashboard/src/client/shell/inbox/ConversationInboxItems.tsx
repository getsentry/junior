import { ChevronRight, Inbox } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { InboxItemPayload } from "@sentry/junior/api/schema";

import { LoadMorePagination } from "../../components/Pagination";
import {
  Collapsible,
  CollapsibleContent,
} from "../../components/ui/collapsible";
import {
  DetailsCard,
  DetailsList,
  DetailsRow,
} from "../../conversations/DetailsList";
import { cn, dashboardDisclosureChevronClass } from "../../styles";
import { useMobileLayout } from "../../layoutMedia";
import { InboxItemCard } from "./InboxItemCard";
import { InboxItemSheet } from "../../inbox/InboxItemSheet";
import { AskKindIcon, askIcon } from "../../inbox/askKind";
import { inboxItemKind } from "../../inbox/inboxModel";
import { useInboxItemsData } from "../../inbox/queries";
import { inboxItemTitleText } from "../../inbox/inboxItemFormat";

/**
 * Show the open Inbox items linked to a Conversation in its details. Each
 * item is one line, like its sidebar chip, and expands to the full card in
 * place, or opens it in a sheet on a phone. `highlight` marks the card
 * when a sidebar link opened it.
 */
export function ConversationInboxItems(props: {
  conversationId: string;
  highlight: boolean;
}) {
  const { items: linked, query } = useInboxItemsData({
    conversationId: props.conversationId,
  });
  // An item that the viewer snoozed keeps only its record in the
  // transcript.
  const items = linked.filter((item) => !item.snoozedByViewer);
  const sectionRef = useRef<HTMLDivElement>(null);
  const mobile = useMobileLayout();
  const shown = items.length > 0;
  useEffect(() => {
    if (props.highlight && shown) {
      sectionRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [props.highlight, shown]);
  if (!shown) return null;
  return (
    <div
      className={cn(
        "rounded-lg",
        props.highlight && "ring-2 ring-dashboard-focus/50",
      )}
      ref={sectionRef}
    >
      {/* A count of loaded pages only would understate, so hide it. */}
      <DetailsCard
        count={query.hasNextPage ? undefined : items.length}
        label="Inbox"
        title="Inbox"
      >
        <DetailsList
          itemKey={(item) => item.id}
          items={items}
          renderItem={(item) => (
            <InboxItemRow
              // A phone opens an item in a sheet, so it opens one only when
              // the list has one item. The section's ring marks the rest.
              defaultExpanded={
                props.highlight && (!mobile || items.length === 1)
              }
              item={item}
            />
          )}
        />
        <LoadMorePagination
          className="mt-2"
          hasMore={Boolean(query.hasNextPage)}
          loading={query.isFetchingNextPage}
          onLoadMore={() => void query.fetchNextPage()}
        />
      </DetailsCard>
    </div>
  );
}

function InboxItemRow(props: {
  defaultExpanded: boolean;
  item: InboxItemPayload;
}) {
  // A phone opens the item in a sheet, not in place. The two states stay
  // apart, so rows open in place do not each open a sheet on a resize.
  const mobile = useMobileLayout();
  const [expanded, setExpanded] = useState(props.defaultExpanded && !mobile);
  const [sheet, setSheet] = useState(props.defaultExpanded && mobile);
  if (sheet && !mobile) setSheet(false);
  const kind = inboxItemKind(props.item);
  // Details can already be open when a sidebar review chip highlights it.
  useEffect(() => {
    if (!props.defaultExpanded) return;
    if (mobile) setSheet(true);
    else setExpanded(true);
  }, [mobile, props.defaultExpanded]);
  const row = (
    <DetailsRow
      disclosure={!mobile}
      icon={
        // The kind's icon, as the Inbox pills show it.
        askIcon(kind) ? (
          <AskKindIcon kind={kind} />
        ) : (
          <Inbox aria-hidden="true" className="size-3.5" />
        )
      }
      meta={
        <span className="grid size-5 place-items-center">
          <ChevronRight
            aria-hidden="true"
            className={dashboardDisclosureChevronClass}
          />
        </span>
      }
      onClick={mobile ? () => setSheet(true) : undefined}
      title={inboxItemTitleText(props.item)}
    />
  );
  if (mobile) {
    return (
      <>
        {row}
        {sheet ? (
          <InboxItemSheet item={props.item} onClose={() => setSheet(false)} />
        ) : null}
      </>
    );
  }
  return (
    <Collapsible className="min-w-0" onOpenChange={setExpanded} open={expanded}>
      {row}
      <CollapsibleContent className="px-1.5 pb-1">
        <InboxItemCard item={props.item} />
      </CollapsibleContent>
    </Collapsible>
  );
}
