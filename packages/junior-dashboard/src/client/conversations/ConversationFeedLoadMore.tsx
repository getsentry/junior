import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { useAutoLoadHistoryPage } from "./transcriptBottomPinning";

/** Next-page state of the viewer's conversation feed. */
export type ConversationFeedMorePages = {
  failed: boolean;
  hasMore: boolean;
  loading: boolean;
  onLoadMore(): void;
};

/**
 * Load the next conversation feed page when the reader scrolls near the end
 * of the list. A failed load waits for a click, so it does not retry in a
 * loop while the end stays visible.
 */
export function ConversationFeedLoadMore(
  props: ConversationFeedMorePages & { loadedCount: number },
) {
  const sentinel = useAutoLoadHistoryPage({
    edge: "bottom",
    enabled: props.hasMore && !props.loading && !props.failed,
    // Watch again after each page, in case the end of the list is still visible.
    historyVersion: String(props.loadedCount),
    onLoad: props.onLoadMore,
  });
  if (!props.hasMore) return null;
  return (
    <div className="grid min-h-10 place-items-center py-2" ref={sentinel}>
      {props.loading ? (
        <Spinner
          aria-label="Loading more conversations"
          className="text-dashboard-text-faint"
        />
      ) : props.failed ? (
        <p className="m-0 flex items-center gap-2 text-xs text-dashboard-text-muted">
          Could not load more.
          <Button onClick={props.onLoadMore} variant="quiet">
            Retry
          </Button>
        </p>
      ) : null}
    </div>
  );
}
