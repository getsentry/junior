import { lazy, Suspense, useEffect, useState } from "react";
import { useSearchParams } from "react-router";

// The dialog and its snooze code load only when a link opens it, so the
// first load skips them.
const LinkedSnoozeDialog = lazy(() =>
  import("./LinkedSnoozeDialog").then((module) => ({
    default: module.LinkedSnoozeDialog,
  })),
);

/**
 * Open the snooze dialog of one item from a link: `?item=<id>&snooze=1`. A
 * chat card links it, since a message there looks the same to everyone
 * and cannot hide for one person. The link leaves the URL at once, so the
 * page under it keeps its own handling of `?item=`.
 */
export function LinkedSnooze() {
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
  if (!itemId) return null;
  return (
    <Suspense fallback={null}>
      <LinkedSnoozeDialog
        itemId={itemId}
        onClose={() => setItemId(undefined)}
      />
    </Suspense>
  );
}
