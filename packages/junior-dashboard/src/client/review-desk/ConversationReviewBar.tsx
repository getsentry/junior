import { ChevronRight } from "lucide-react";
import { useState } from "react";

import { Drawer } from "../components/Drawer";
import { ReviewItemCard } from "./ReviewItemCard";
import { useReviewItemsData } from "./queries";

function itemCountLabel(count: number): string {
  return count === 1 ? "1 open review item" : `${count} open review items`;
}

/**
 * Show how many open Review items are linked to a Conversation, above its
 * message box. The bar opens a side panel where the viewer can act on each.
 */
export function ConversationReviewBar(props: { conversationId: string }) {
  const [open, setOpen] = useState(false);
  const items =
    useReviewItemsData({
      archived: false,
      conversationId: props.conversationId,
      view: "all",
    }).data?.items ?? [];
  if (items.length === 0) return null;
  const label = itemCountLabel(items.length);
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
          width="narrow"
        >
          <div className="grid gap-3">
            {items.map((item) => (
              <ReviewItemCard item={item} key={item.id} />
            ))}
          </div>
        </Drawer>
      ) : null}
    </>
  );
}
