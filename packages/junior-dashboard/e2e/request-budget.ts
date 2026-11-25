import { expect, type Page, type Request } from "@playwright/test";
import { waitForRequestsToEnd } from "./harness";

/** The API requests of one page load. */
export type RequestBudget = {
  /** Requests to `/api/`, mocked ones included. */
  requests: number;
  /**
   * The longest chain of requests where each one starts after the one before
   * it ends. Requests that the page sends at the same time share a round.
   */
  serialRounds: number;
};

type Span = { start: number; end?: number };

function serialRounds(spans: readonly Span[]): number {
  const rounds: number[] = [];
  for (const [index, span] of spans.entries()) {
    let before = 0;
    for (const [previous, other] of spans.slice(0, index).entries()) {
      if (other.end !== undefined && other.end < span.start) {
        before = Math.max(before, rounds[previous]!);
      }
    }
    rounds.push(before + 1);
  }
  return Math.max(0, ...rounds);
}

/**
 * Run `load`, wait until each request that it started has ended, and assert
 * that the page sent at most the budgeted API requests and serial rounds. Set
 * the budget to the measured value. Lower it when a change sends fewer
 * requests. Do not raise it to pass.
 */
export async function expectRequestBudget(
  page: Page,
  load: () => Promise<void>,
  budget: RequestBudget,
): Promise<void> {
  // Event order, not time, decides whether one request waits on another.
  let order = 0;
  const spans = new Map<Request, Span>();
  const onRequest = (request: Request) => {
    if (!new URL(request.url()).pathname.startsWith("/api/")) return;
    order += 1;
    spans.set(request, { start: order });
  };
  const onDone = (request: Request) => {
    const span = spans.get(request);
    if (!span) return;
    order += 1;
    span.end = order;
  };
  page.on("request", onRequest);
  page.on("requestfinished", onDone);
  page.on("requestfailed", onDone);
  try {
    await load();
    await waitForRequestsToEnd(page);
  } finally {
    page.off("request", onRequest);
    page.off("requestfinished", onDone);
    page.off("requestfailed", onDone);
  }
  const all = [...spans.values()];
  const measured = { requests: all.length, serialRounds: serialRounds(all) };
  expect(measured.requests).toBeLessThanOrEqual(budget.requests);
  expect(measured.serialRounds).toBeLessThanOrEqual(budget.serialRounds);
}
