import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Flame } from "lucide-react";
import {
  cacheWarmingBreakerListSchema,
  closeCacheWarmingBreakerResponseSchema,
} from "@sentry/junior/api/schema";
import { Button } from "../../components/ui/button";
import { InlineError } from "../../components/InlineError";
import { StatusChip } from "../../components/StatusChip";
import { Card } from "../../components/layout/Card";
import { AnchorHeading } from "../../components/layout/AnchorHeading";
import { del, fetchDashboardJson } from "../../http";

const breakersQueryKey = ["dashboard", "cache-warming", "breakers"] as const;

/**
 * Show which providers have cache warming paused by the breaker, and let an
 * admin turn warming back on.
 */
export function CacheWarmingSection() {
  const queryClient = useQueryClient();
  const breakersQuery = useQuery({
    queryKey: breakersQueryKey,
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        cacheWarmingBreakerListSchema,
        "/api/cache-warming/breakers",
        signal,
      ),
    retry: false,
  });
  const closeMutation = useMutation({
    mutationFn: (provider: string) =>
      del(
        closeCacheWarmingBreakerResponseSchema,
        `/api/cache-warming/breakers/${encodeURIComponent(provider)}`,
      ),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: breakersQueryKey }),
  });

  const breakers = breakersQuery.data?.breakers ?? [];
  const listFailed = !breakersQuery.data && breakersQuery.isError;
  const displayedError = closeMutation.isError
    ? "Could not turn warming back on. Try again."
    : listFailed
      ? "Could not load cache warming. Try again."
      : undefined;

  return (
    <Card as="section" padding="md">
      <AnchorHeading
        anchor="cache-warming"
        className="m-0 font-display text-base font-medium text-dashboard-text"
        title="Cache warming"
      />
      <p className="mt-1 mb-4 text-sm text-dashboard-text-muted">
        When too many warmups of a provider miss the cache, warming of that
        provider pauses for every conversation. Turn it back on when the
        provider has recovered.
      </p>
      {displayedError ? (
        <InlineError className={listFailed ? undefined : "mb-4"}>
          {displayedError}
        </InlineError>
      ) : null}
      {listFailed ? null : breakersQuery.isPending ? (
        <p className="m-0 text-sm text-dashboard-text-muted">
          Loading cache warming…
        </p>
      ) : (
        <div className="space-y-2">
          {breakers.map((breaker) => (
            <div
              className="flex items-center gap-3 rounded-md border border-dashboard-border-strong p-3"
              key={breaker.provider}
            >
              <Flame
                aria-hidden="true"
                className="shrink-0 text-dashboard-accent"
                size={16}
              />
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <p className="m-0 truncate font-mono text-sm font-semibold">
                  {breaker.provider}
                </p>
                <StatusChip
                  size="compact"
                  tone={breaker.open ? "warning" : "success"}
                >
                  {breaker.open ? "paused" : "on"}
                </StatusChip>
              </div>
              {breaker.open ? (
                <Button
                  aria-busy={
                    closeMutation.isPending &&
                    closeMutation.variables === breaker.provider
                  }
                  aria-label={`Turn ${breaker.provider} cache warming back on`}
                  disabled={closeMutation.isPending}
                  onClick={() => closeMutation.mutate(breaker.provider)}
                  variant="outline"
                >
                  Turn on
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
