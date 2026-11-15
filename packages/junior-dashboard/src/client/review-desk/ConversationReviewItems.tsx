import { ChevronRight, Inbox } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReviewItemPayload } from "@sentry/junior/api/schema";

import { LoadMorePagination } from "../components/Pagination";
import { Collapsible, CollapsibleContent } from "../components/ui/collapsible";
import {
  DetailsCard,
  DetailsList,
  DetailsRow,
} from "../conversations/DetailsList";
import { cn, dashboardDisclosureChevronClass } from "../styles";
import { ReviewItemCard } from "./ReviewItemCard";
import { useReviewItemsData } from "./queries";

/**
 * Show the open Review items linked to a Conversation in its details. Each
 * item is one line, like its sidebar chip, and expands to the full card in
 * place. `highlight` marks the card when a sidebar link opened it.
 */
export function ConversationReviewItems(props: {
  conversationId: string;
  highlight: boolean;
}) {
  const { items, query } = useReviewItemsData({
    conversationId: props.conversationId,
  });
  const sectionRef = useRef<HTMLDivElement>(null);
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
        props.highlight && "ring-2 ring-violet-300/50",
      )}
      ref={sectionRef}
    >
      {/* A count of loaded pages only would understate, so hide it. */}
      <DetailsCard
        count={query.hasNextPage ? undefined : items.length}
        label="Needs you"
        title="Needs you"
      >
        <DetailsList
          itemKey={(item) => item.id}
          items={items}
          renderItem={(item) => (
            <ReviewItemRow defaultExpanded={props.highlight} item={item} />
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

function ReviewItemRow(props: {
  defaultExpanded: boolean;
  item: ReviewItemPayload;
}) {
  const [expanded, setExpanded] = useState(props.defaultExpanded);
  // Details can already be open when a sidebar review chip highlights it.
  useEffect(() => {
    if (props.defaultExpanded) setExpanded(true);
  }, [props.defaultExpanded]);
  return (
    <Collapsible className="min-w-0" onOpenChange={setExpanded} open={expanded}>
      <DetailsRow
        disclosure
        icon={<Inbox aria-hidden="true" className="size-3.5" />}
        meta={
          <span className="grid size-5 place-items-center">
            <ChevronRight
              aria-hidden="true"
              className={dashboardDisclosureChevronClass}
            />
          </span>
        }
        title={props.item.title}
      />
      <CollapsibleContent className="px-1.5 pb-1">
        <ReviewItemCard item={props.item} />
      </CollapsibleContent>
    </Collapsible>
  );
}
