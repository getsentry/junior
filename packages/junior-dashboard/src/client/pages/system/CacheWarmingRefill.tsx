import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import {
  cacheWarmingSavingsRefillResponseSchema,
  type CacheWarmingSavingsRefill,
} from "@sentry/junior/api/schema";
import { Button } from "../../components/ui/button";
import { formatCompactNumber, formatRelativeTime } from "../../format";
import { fetchDashboardJson, post } from "../../http";

const refillQueryKey = ["dashboard", "cache-warming", "refill"] as const;
const savingsQueryKey = ["dashboard", "cache-warming", "savings"] as const;
const REFILL_PATH = "/api/cache-warming/savings/refill";

const isActive = (refill: CacheWarmingSavingsRefill | undefined) =>
  refill?.status === "pending" || refill?.status === "running";

function describe(refill: CacheWarmingSavingsRefill): string {
  switch (refill.status) {
    case "idle":
      return "Fills the days before live recording from stored history.";
    case "pending":
      return "Re-fill queued.";
    case "running":
      return `Re-filling history: ${formatCompactNumber(refill.scannedConversations)} of ${formatCompactNumber(refill.totalConversations)} conversations.`;
    case "done":
      return `Last re-fill finished ${formatRelativeTime(refill.finishedAt)}.`;
    case "failed":
      return `Re-fill failed: ${refill.error ?? "unknown error"}`;
  }
}

/**
 * Let an admin re-fill the cache warming savings of the days before live
 * recording from stored history, and show the state of the last re-fill.
 */
export function CacheWarmingRefill() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: refillQueryKey,
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        cacheWarmingSavingsRefillResponseSchema,
        REFILL_PATH,
        signal,
      ),
    // A slice runs about once a minute.
    refetchInterval: (current) =>
      isActive(current.state.data?.refill) ? 10_000 : false,
    retry: false,
  });
  const start = useMutation({
    mutationFn: () =>
      post(cacheWarmingSavingsRefillResponseSchema, REFILL_PATH, {}),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: refillQueryKey }),
  });
  const refill = query.data?.refill;
  // A re-fill that finished while the page was open changed the savings.
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && refill?.status === "done") {
      void queryClient.invalidateQueries({ queryKey: savingsQueryKey });
    }
    wasActive.current = isActive(refill);
  }, [refill, queryClient]);

  const message = start.isError
    ? "Could not start the re-fill. Try again."
    : refill
      ? describe(refill)
      : query.isError
        ? "Could not load the re-fill state."
        : undefined;
  const failed = start.isError || refill?.status === "failed";
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <Button
        aria-busy={start.isPending || isActive(refill)}
        disabled={!refill || start.isPending || isActive(refill)}
        onClick={() => start.mutate()}
        variant="outline"
      >
        Re-fill history
      </Button>
      {message ? (
        <p
          className={`m-0 font-sans text-xs leading-relaxed ${failed ? "text-rose-200" : "text-dashboard-text-muted"}`}
          role="status"
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}
