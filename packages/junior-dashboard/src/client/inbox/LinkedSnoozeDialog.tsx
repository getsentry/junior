import { lazy, Suspense, useEffect, useState } from "react";
import { useSearchParams } from "react-router";

import { useSnoozeInboxItem } from "./inboxSnoozes";
import { useInboxItemData } from "./queries";
import { eventSnoozeOf } from "./snoozeChoices";

// The dialog loads only when a link opens it.
const SnoozeDialog = lazy(() =>
  import("./SnoozeDialog").then((module) => ({
    default: module.SnoozeDialog,
  })),
);

/**
 * Open the snooze dialog of one item from a link: `?item=<id>&snooze=1`. A
 * chat card links it, since a message there looks the same to everyone
 * and cannot hide for one person. The link leaves the URL at once, so the
 * page under it keeps its own handling of `?item=`.
 */
export function LinkedSnoozeDialog() {
  const [params, setParams] = useSearchParams();
  const [itemId, setItemId] = useState<string>();
  const linkedId = params.get("snooze") ? params.get("item") : null;
  useEffect(() => {
    if (!linkedId) return;
    setItemId(linkedId);
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("snooze");
        return next;
      },
      { replace: true },
    );
  }, [linkedId, setParams]);
  const item = useInboxItemData(itemId).data;
  const snooze = useSnoozeInboxItem();
  if (!item || item.status !== "open") return null;
  const close = () => setItemId(undefined);
  return (
    <Suspense fallback={null}>
      <SnoozeDialog
        events={eventSnoozeOf([item], (end) => void snooze(item, end))}
        nowMs={Date.now()}
        onClose={close}
        onSnooze={(end) => void snooze(item, end)}
      />
    </Suspense>
  );
}
