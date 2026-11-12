/** Review items and an API mock shared by the Inbox e2e specs. */
import type { Locator, Page } from "@playwright/test";
import { attentionCount } from "./automation-fixture";

export const viewer = {
  displayName: "Dashboard User",
  email: "dev@example.com",
  userId: "u-dev",
};

const base = {
  addedByConversationId: "slack:CREVIEW:1770003600.000200",
  assignedToEveryone: false,
  assignees: [viewer],
  canAct: true,
  canTake: false,
  conversationIds: [],
  createdAt: "2026-08-07T08:00:00.000Z",
  kind: "action" as const,
  status: "open" as const,
  updatedAt: "2026-08-07T08:30:00.000Z",
  visibility: "public" as const,
};

export const conversationId = "slack:CQA123:1770003600.000200";

// Added between messages of the mock Conversation, so the inbox shows the
// messages before it and a new one after it.
export const rollout = {
  ...base,
  addedByConversationId: conversationId,
  body: "Canary error rate is flat.",
  createdAt: "2026-08-07T11:54:30.000Z",
  id: "item-rollout",
  request: {
    question: "Roll out payments-v42?",
    fields: [
      {
        id: "go",
        kind: "choice",
        label: "Rollout",
        options: [{ label: "Roll out" }, { label: "Hold" }],
      },
    ],
  },
  title: "Approve the payments-v42 rollout",
};

export const license = {
  ...base,
  body: "The acme entry changed its license.",
  id: "item-license",
  request: {
    question: "Does acme still meet the definition?",
    fields: [
      {
        id: "decision",
        kind: "choice",
        label: "Decision",
        options: [{ label: "Approve" }, { label: "Reject" }],
      },
      { id: "reason", kind: "text", label: "Reason" },
    ],
  },
  title: "Review the acme license entry",
};

export const audit = {
  ...license,
  createdAt: "2026-08-07T09:10:00.000Z",
  id: "item-audit",
  title: "Review the globex license entry",
};

export const prReady = {
  ...base,
  body: "Junior opened a pull request for the payments retry fix.",
  id: "item-pr-ready",
  kind: "notice" as const,
  subject: {
    id: "acme/payments#42",
    title: "fix(payments): Retry declined webhooks",
    url: "https://github.com/acme/payments/pull/42",
  },
  title: "Pull request ready for review",
};

export const answered = {
  ...license,
  answer: {
    requestId: "request-initech",
    values: { decision: ["Approve"], reason: ["MIT license, no change."] },
  },
  body: "The initech entry changed its license.",
  closedAt: "2026-08-07T09:40:00.000Z",
  createdAt: "2026-08-07T09:30:00.000Z",
  closedBy: viewer,
  id: "item-initech",
  status: "done" as const,
  title: "Review the initech license entry",
};

const dismissedNotice = {
  ...base,
  body: "The nightly digest skipped two noisy alerts.",
  closeReason: "Muted both alerts.",
  closedAt: "2026-08-07T09:50:00.000Z",
  closedBy: viewer,
  id: "item-digest",
  kind: "notice" as const,
  status: "dismissed" as const,
  title: "Digest skipped two alerts",
};

// The agent added this item in the Conversation, so a message there closes it.
export const migration = {
  ...license,
  addedByConversationId: conversationId,
  body: "The billing migration is ready.",
  conversationIds: [conversationId],
  createdAt: "2026-08-07T10:20:00.000Z",
  id: "item-migration",
  title: "Pick the billing migration window",
};

// The GitHub plugin's ask for a Junior pull request: an action item with no
// question. The mock Conversation has the object annotation for the same URL.
export const prMerge = {
  ...base,
  addedByConversationId: conversationId,
  body: "**Retry checkout writes after lock timeouts** is approved, and GitHub says that it can merge.",
  conversationIds: [conversationId],
  createdAt: "2026-08-07T11:00:00.000Z",
  id: "item-pr-merge",
  kind: "action" as const,
  subject: {
    id: "https://github.com/getsentry/payments/pull/42",
    title: "Retry checkout writes after lock timeouts",
    url: "https://github.com/getsentry/payments/pull/42",
  },
  title: "Ready to merge · #42",
};

// A second GitHub ask, so pull requests group by state.
export const prReview = {
  ...prMerge,
  addedByConversationId: "slack:CREVIEW:1770003600.000200",
  body: "GitHub asks you to review **Pin the release train**.",
  conversationIds: [],
  createdAt: "2026-08-07T09:00:00.000Z",
  id: "item-pr-review",
  subject: {
    id: "https://github.com/getsentry/payments/pull/91",
    title: "Pin the release train",
    url: "https://github.com/getsentry/payments/pull/91",
  },
  title: "Review requested · #91",
};

// A notice for Everyone in another Conversation: FYI, so a sweep clears it.
export const digest = {
  ...base,
  addedByConversationId: "scheduler:daily-ops-digest",
  assignedToEveryone: true,
  assignees: [],
  body: "The digest skipped two noisy alerts.",
  createdAt: "2026-08-07T07:00:00.000Z",
  id: "item-digest-open",
  kind: "notice" as const,
  title: "Digest skipped two noisy alerts",
};

/**
 * Serve the given open items and the archived one. An answer or dismiss
 * closes the item, as on the server, so the inbox can move on. `keepOpen`
 * keeps an answered item open, so a test can answer it twice.
 */
export async function mockReviewItems(
  page: Page,
  options: {
    /**
     * Attention Automations in the count, read on each count request. The
     * mocked list's by default.
     */
    automations?: () => number;
    failActions?: string[];
    keepOpen?: boolean;
    open?: unknown[];
    pageSize?: number;
  } = {},
) {
  const actions: { body: unknown; id: string }[] = [];
  let open = (options.open ?? [
    rollout,
    license,
    audit,
    prReady,
    migration,
  ]) as (typeof license)[];
  const archived = [answered, dismissedNotice];
  // Items closed in this test. Their detail reads closed, as on the server.
  const closedNow: (typeof license)[] = [];
  await page.route("**/api/review-items**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^.*\/api\/review-items/, "");
    // The tab badge counts what waits on the viewer, as the server does.
    if (path === "/count") {
      return route.fulfill({
        json: {
          automations: (options.automations ?? attentionCount)(),
          needsViewer: open.filter(
            (i) => i.kind === "action" && i.canAct && !i.assignedToEveryone,
          ).length,
        },
      });
    }
    if (path === "" || path === "/") {
      const linked = url.searchParams.get("conversationId");
      const q = url.searchParams.get("q")?.toLowerCase() ?? "";
      // A status list has only closed items, newest closed first. A search
      // matches title or body, and also finds closed items after the open.
      const closed = (url.searchParams.get("status") ?? "open") !== "open";
      const list = (
        closed
          ? [...archived].sort((x, y) => y.closedAt.localeCompare(x.closedAt))
          : q
            ? [...open, ...archived]
            : open
      ).filter(
        (i) =>
          (!linked || i.conversationIds.includes(linked)) &&
          `${i.title}\n${i.body}`.toLowerCase().includes(q),
      );
      // The waiting sort lists what waits on the viewer first, then the
      // rest, newest first, as the server does. Otherwise items keep their
      // order.
      if (!closed && url.searchParams.get("sort") === "waiting") {
        const waits = (i: (typeof list)[number]) =>
          Number(i.kind === "action" && i.canAct && !i.assignedToEveryone);
        list.sort(
          (x, y) =>
            waits(y) - waits(x) ||
            y.createdAt.localeCompare(x.createdAt) ||
            y.id.localeCompare(x.id),
        );
      }
      // The cursor is the index of the first item of the page.
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const end = start + (options.pageSize ?? list.length);
      return route.fulfill({
        json: {
          items: list.slice(start, end),
          ...(end < list.length ? { nextCursor: String(end) } : undefined),
        },
      });
    }
    const action = path.match(/^\/([^/]+)\/actions$/);
    if (action) {
      const id = decodeURIComponent(action[1]!);
      const item = open.find((i) => i.id === id);
      if (options.failActions?.includes(id))
        return route.fulfill({ json: { error: "Failed" }, status: 500 });
      actions.push({ body: route.request().postDataJSON(), id });
      if (options.keepOpen) return route.fulfill({ json: item });
      open = open.filter((i) => i.id !== id);
      if (item) closedNow.push({ ...item, status: "done" });
      return route.fulfill({ json: { ...item, status: "done" } });
    }
    const item = [...open, ...closedNow, ...archived].find(
      (i) => i.id === decodeURIComponent(path.slice(1)),
    );
    return item
      ? route.fulfill({ json: item })
      : route.fulfill({ json: { error: "Not found" }, status: 404 });
  });
  return actions;
}

/**
 * Serve the viewer's code changes from their person Code overview, for the
 * Pull requests view. Each change is in getsentry/payments and opened 30
 * days before the report.
 */
export async function mockViewerCodeChanges(
  page: Page,
  changes: readonly {
    draft?: boolean;
    idleDays: number;
    number: number;
    state?: "closed" | "merged" | "open";
    title: string;
  }[],
) {
  // Like the server: 100 changes a page, in the given order, and the offset
  // of the next page while one is left.
  await page.route(/\/api\/people\/[^/]+\/code(\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const report = await response.json();
    const nowMs = Date.parse(report.generatedAt);
    const daysAgo = (days: number) =>
      new Date(nowMs - days * 86_400_000).toISOString();
    const offset = Number(
      new URL(route.request().url()).searchParams.get("offset") ?? 0,
    );
    await route.fulfill({
      response,
      json: {
        ...report,
        nextOffset: offset + 100 < changes.length ? offset + 100 : undefined,
        changes: changes.slice(offset, offset + 100).map((change) => ({
          draft: change.draft ?? false,
          id: `00000000-0000-4000-9000-${String(change.number).padStart(12, "0")}`,
          lastActivityAt: daysAgo(change.idleDays),
          number: change.number,
          openedAt: daysAgo(30),
          provider: "github",
          repository: "getsentry/payments",
          state: change.state ?? "open",
          title: change.title,
          url: `https://github.com/getsentry/payments/pull/${change.number}`,
        })),
      },
    });
  });
}

/**
 * The head of the Inbox row titled `title`. A click or Enter expands the
 * row in place; only Open leaves the list.
 */
export function rowHead(scope: Page | Locator, title: string) {
  return scope
    .locator("[data-inbox-row]")
    .filter({ hasText: title })
    .getByRole("link", { name: title })
    .first();
}

/**
 * Open the Conversation of the Inbox row whose head is `head`, with the
 * row's Open action. A click on the head only expands the row.
 */
export async function openRow(head: Locator) {
  await head.hover();
  await head
    .locator("xpath=ancestor::*[@data-inbox-row][1]")
    .getByRole("link", { name: "Open conversation" })
    .first()
    .click();
}
