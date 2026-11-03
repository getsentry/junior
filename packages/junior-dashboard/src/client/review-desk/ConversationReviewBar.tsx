import { ChevronRight } from "lucide-react";
import { useSearchParams } from "react-router";

import { Drawer } from "../components/Drawer";
import { LoadMorePagination } from "../components/Pagination";
import { ReviewItemCard } from "./ReviewItemCard";
import { useReviewItemsData } from "./queries";
import {
  CONVERSATION_REVIEW_OPEN,
  CONVERSATION_REVIEW_PARAM,
} from "../conversations/conversationRoutes";

/** `more` marks a count of the loaded pages only, such as "50+". */
function itemCountLabel(count: number, more: boolean): string {
  if (more) return `${count}+ open review items`;
  return count === 1 ? "1 open review item" : `${count} open review items`;
}

/**
 * Show how many open Review items are linked to a Conversation, above its
 * message box. The bar opens a side panel where the viewer can act on each.
 * The URL owns the panel, so a sidebar link can open it.
 */
export function ConversationReviewBar(props: { conversationId: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const open =
    searchParams.get(CONVERSATION_REVIEW_PARAM) === CONVERSATION_REVIEW_OPEN;
  const setOpen = (value: boolean) =>
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value)
          next.set(CONVERSATION_REVIEW_PARAM, CONVERSATION_REVIEW_OPEN);
        else next.delete(CONVERSATION_REVIEW_PARAM);
        return next;
      },
      { replace: true },
    );
  const { items, query } = useReviewItemsData({
    conversationId: props.conversationId,
  });
  if (items.length === 0) return null;
  const more = Boolean(query.hasNextPage);
  const label = itemCountLabel(items.length, more);
  return (
    <>
      <button
        className="mb-2 flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg border border-violet-300/25 bg-violet-300/[0.06] px-3 py-2 text-left font-sans text-sm text-dashboard-text transition-colors hover:bg-violet-300/[0.1]"
        onClick={() => setOpen(true)}
        type="button"
      >
        <span className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full bg-violet-300"
          />
          {label}
        </span>
        <ChevronRight aria-hidden="true" size={16} />
      </button>
      {open ? (
        <Drawer
          closeLabel="Close review items"
          header={
            <h2 className="m-0 font-sans text-base font-semibold">{label}</h2>
          }
          label="Review items"
          onClose={() => setOpen(false)}
          openKey={props.conversationId}
        >
          <div className="grid gap-3">
            {items.map((item) => (
              <ReviewItemCard item={item} key={item.id} />
            ))}
            <LoadMorePagination
              hasMore={more}
              loading={query.isFetchingNextPage}
              onLoadMore={() => void query.fetchNextPage()}
            />
          </div>
        </Drawer>
      ) : null}
    </>
  );
}
