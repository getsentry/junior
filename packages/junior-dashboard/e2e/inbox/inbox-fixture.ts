/** Inbox items and an API mock shared by the Inbox e2e specs. */
import type { Locator, Page } from "@playwright/test";
import { NOW_MS } from "../../src/mock-reporting/fixtures";
import { attentionCount } from "./automation-fixture";
import { PULL_REQUEST_RESOURCE } from "../../src/mock-reporting/snooze-resources";
import { mockSearchRows } from "../search-fixture";
import { mockObjectLinks, mockPeopleCode } from "../mock-reports";

export const viewer = {
  displayName: "Dashboard User",
  email: "dev@example.com",
  userId: "u-dev",
};

const base = {
  owner: { id: "slack:CREVIEW:1770003600.000200", kind: "conversation" },
  rootConversationId: "slack:CREVIEW:1770003600.000200",
  assignedToEveryone: false,
  assignees: [viewer],
  canAct: true,
  canAnswer: true,
  canTake: false,
  conversationIds: [] as string[],
  createdAt: "2026-08-07T08:00:00.000Z",
  kind: "action" as const,
  status: "open" as const,
  updatedAt: "2026-08-07T08:30:00.000Z",
  visibility: "public" as const,
};

/**
 * The subject of a pull request item, as the API sends it: its kind, the
 * label of the kind, and the card that the API read for its URL, with the
 * title that GitHub has now.
 */
export function pullRequestSubject(input: {
  id?: string;
  kind: string;
  label?: string;
  /** False while the pull request conflicts with its target branch. */
  mergeable?: boolean;
  resource?: typeof PULL_REQUEST_RESOURCE;
  title: string;
  titleParts?: {
    breaking?: boolean;
    scope?: string;
    text: string;
    type?: string;
  };
  url: string;
}) {
  const [, repository, number] =
    /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(input.url) ??
    [];
  const key = `${repository}#${number}`;
  return {
    id: input.id ?? input.url,
    kind: input.kind,
    ...(input.label ? { label: input.label } : undefined),
    object: {
      displayType: "Pull request",
      facts: {
        type: "code_change" as const,
        ...(input.mergeable === undefined
          ? undefined
          : { mergeable: input.mergeable }),
        ...(input.titleParts ? { titleParts: input.titleParts } : undefined),
      },
      key,
      kind: "object" as const,
      label: key,
      objectType: "code_change" as const,
      plugin: "github",
      status: "open",
      title: input.title,
      url: input.url,
    },
    objectType: "code_change" as const,
    ...(input.resource ? { resource: input.resource } : undefined),
    url: input.url,
  };
}

export const conversationId = "slack:CQA123:1770003600.000200";

// Added between messages of the mock Conversation, so the inbox shows the
// messages before it and a new one after it.
export const rollout = {
  ...base,
  owner: { id: conversationId, kind: "conversation" },
  rootConversationId: conversationId,
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
  subject: { id: "item-rollout", kind: "question" as const },
};

// A To-do that the checkout Conversation's agent gave the viewer. Its item
// links no Conversation, as the server sends it.
export const todoForYou = {
  ...base,
  owner: { id: conversationId, kind: "conversation" },
  rootConversationId: conversationId,
  body: "Check the deploy calendar before the next release.",
  createdAt: "2026-08-07T11:56:00.000Z",
  id: "item-todo-rollback-window",
  title: "Confirm the rollback window",
  todoId: 13,
  visibility: "private" as const,
  subject: { id: "13", kind: "todo" },
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
  subject: { id: "item-license", kind: "question" as const },
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
  subject: pullRequestSubject({
    id: "acme/payments#42",
    kind: "question",
    title: "fix(payments): Retry declined webhooks",
    url: "https://github.com/acme/payments/pull/42",
  }),
  title: "Pull request ready for review",
};

export const answered = {
  ...license,
  answer: {
    requestId: "request-initech",
    values: { decision: ["Approve"], reason: ["MIT license, no change."] },
  },
  body: "The initech entry changed its license.",
  answeredBy: viewer,
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
  subject: { id: "item-digest", kind: "question" as const },
};

// The agent added this item in the Conversation, so a message there closes it.
export const migration = {
  ...license,
  owner: { id: conversationId, kind: "conversation" },
  rootConversationId: conversationId,
  body: "The billing migration is ready.",
  conversationIds: [conversationId],
  createdAt: "2026-08-07T10:20:00.000Z",
  id: "item-migration",
  title: "Pick the billing migration window",
};

// The Events of a GitHub pull request subject, as the API lists them.
export const pullRequestResource = PULL_REQUEST_RESOURCE;

// The GitHub plugin's ask for a Junior pull request: an action item with no
// question. The mock Conversation has the object annotation for the same URL.
export const prMerge = {
  ...base,
  owner: { id: conversationId, kind: "conversation" },
  rootConversationId: conversationId,
  body: "**Retry checkout writes after lock timeouts** is approved, and GitHub says that it can merge.",
  conversationIds: [conversationId],
  createdAt: "2026-08-07T11:00:00.000Z",
  id: "item-pr-merge",
  kind: "action" as const,
  subject: pullRequestSubject({
    kind: "github:pull_request",
    label: "Ready to merge",
    resource: pullRequestResource,
    title: "Retry checkout writes after lock timeouts",
    url: "https://github.com/getsentry/payments/pull/42",
  }),
  title: "Ready to merge · #42",
};

// A second GitHub ask, so pull requests group by state.
export const prReview = {
  ...prMerge,
  owner: { id: "slack:CREVIEW:1770003600.000200", kind: "conversation" },
  rootConversationId: "slack:CREVIEW:1770003600.000200",
  body: "GitHub asks you to review **Pin the release train**.",
  conversationIds: [],
  createdAt: "2026-08-07T09:00:00.000Z",
  id: "item-pr-review",
  subject: pullRequestSubject({
    kind: "github:pull_request",
    label: "Review requested",
    resource: pullRequestResource,
    title: "Pin the release train",
    url: "https://github.com/getsentry/payments/pull/91",
  }),
  title: "Review requested · #91",
};

// The release Conversation saved the card of this pull request, with its
// description.
const releaseConversationId = "slack:CQA456:1770021600.000600";
const pinPullRequest = pullRequestSubject({
  kind: "github:pull_request",
  label: "Review requested",
  // The live card says that it conflicts with main.
  mergeable: false,
  title: "Pin the release train to payments 4.2 (#91)",
  url: "https://github.com/getsentry/payments/pull/91",
});

// The GitHub plugin's review ask, as it writes it: the URL alone on a line.
export const pinReview = {
  ...base,
  owner: { id: releaseConversationId, kind: "conversation" },
  rootConversationId: releaseConversationId,
  body: "GitHub asks you to review #91.\n\nhttps://github.com/getsentry/payments/pull/91",
  conversationIds: [releaseConversationId],
  createdAt: "2026-08-07T09:20:00.000Z",
  id: "item-pin-review",
  subject: pinPullRequest,
  title: "Review requested · #91",
};

// A notice about the same pull request, with the URL inside its sentence.
export const pinChecks = {
  ...pinReview,
  body: "The required checks failed on **Pin the release train to payments 4.2**: https://github.com/getsentry/payments/pull/91",
  createdAt: "2026-08-07T09:40:00.000Z",
  id: "item-pin-checks",
  kind: "notice" as const,
  title: "Checks failed · #91",
};

// A notice in the same Conversation about nothing that an ask names.
export const releaseNotes = {
  ...base,
  owner: { id: releaseConversationId, kind: "conversation" },
  rootConversationId: releaseConversationId,
  body: "Release notes for 0.288.0 are drafted in the release PR.",
  conversationIds: [releaseConversationId],
  createdAt: "2026-08-07T09:30:00.000Z",
  id: "item-release-notes",
  kind: "notice" as const,
  title: "Release notes drafted",
  subject: { id: "item-release-notes", kind: "question" as const },
};

// A notice for Everyone in another Conversation: FYI, so a sweep clears it.
export const digest = {
  ...base,
  owner: { id: "scheduler:daily-ops-digest", kind: "conversation" },
  rootConversationId: "scheduler:daily-ops-digest",
  assignedToEveryone: true,
  assignees: [],
  body: "The digest skipped two noisy alerts.",
  createdAt: "2026-08-07T07:00:00.000Z",
  id: "item-digest-open",
  kind: "notice" as const,
  title: "Digest skipped two noisy alerts",
  subject: { id: "item-digest-open", kind: "question" as const },
};

// An ask for Everyone in its own Conversation: up for grabs until someone
// takes it.
export const grab = {
  ...base,
  owner: { id: "slack:CGRAB:1770003600.000300", kind: "conversation" },
  rootConversationId: "slack:CGRAB:1770003600.000300",
  assignedToEveryone: true,
  assignees: [],
  body: "The usual on-call is out on Friday.",
  canTake: true,
  createdAt: "2026-08-07T10:00:00.000Z",
  id: "item-grab",
  request: {
    question: "Who covers the Friday deploy?",
    fields: [
      {
        id: "cover",
        kind: "choice",
        label: "Cover",
        options: [{ label: "I can" }, { label: "Not this week" }],
      },
    ],
  },
  title: "Cover the Friday deploy",
  subject: { id: "item-grab", kind: "question" as const },
};

/**
 * The alert of an Automation that needs its creator: an Inbox item that the
 * Automation owns, with no Conversation.
 */
export function automationAlert(automationId: string, title: string) {
  return {
    ...base,
    body: "Blocked: GitHub access expired. Fix the problem, then resume it.",
    createdAt: "2026-08-07T11:00:00.000Z",
    id: `alert-${automationId}`,
    owner: { id: automationId, kind: "automation" },
    // An Automation's item has no root Conversation. JSON drops the key.
    rootConversationId: undefined,
    subject: { id: automationId, kind: "automation" },
    title,
  };
}

/**
 * The alert of a scheduled Automation whose last run failed, with the steps
 * that core takes: Run again and Pause.
 */
export function failedRunAlert(automationId: string, title: string) {
  return {
    ...automationAlert(automationId, title),
    body: "Last run failed.",
    id: `alert-run-${automationId}`,
    request: {
      question: "Last run failed.",
      fields: [
        {
          id: "step",
          kind: "choice",
          label: "Next step",
          options: [{ label: "Run again" }, { label: "Pause" }],
        },
      ],
    },
  };
}

/** The fields of an item that the mock reads or changes. */
type MockItem = Omit<typeof license, "status"> & {
  status: string;
  subject?: { objectType?: string };
};

/**
 * Serve the given open items and the archived one. An answer or dismiss
 * closes the item, as on the server, so the inbox can move on. `keepOpen`
 * keeps an answered item open, so a test can answer it twice. Snoozes live
 * here too: a snoozed row leaves the viewer's lists until its time passes
 * `now`, which is the test's clock. The versions token moves with them, as
 * on the server.
 */
export async function mockInboxItems(
  page: Page,
  options: {
    /**
     * Attention Automations in the count, read on each count request. The
     * mocked list's by default.
     */
    automations?: () => number;
    failActions?: string[];
    keepOpen?: boolean;
    /**
     * The time a snooze's wake time is checked against: the page's pinned clock
     * by default. A test that moves the clock passes the page's time.
     */
    now?: () => number | Promise<number>;
    open?: unknown[];
    pageSize?: number;
    /** Snoozes that exist before the page loads. */
    snoozes?: ({ untilMs: number } & (
      | { conversationId: string; inboxItemId?: string }
      | { inboxItemId: string }
    ))[];
  } = {},
) {
  const actions: { body: unknown; id: string }[] = [];
  let open = (options.open ?? [
    rollout,
    license,
    audit,
    prReady,
    migration,
  ]) as MockItem[];
  // As on the server, a root Conversation's row also holds the items that
  // link it.
  const inRow = (
    conversationId: string,
    item: {
      conversationIds: readonly string[];
      owner: { id: string };
      rootConversationId?: string;
    },
  ) =>
    item.rootConversationId === conversationId ||
    item.owner.id === conversationId ||
    item.conversationIds.includes(conversationId);
  /** The open items of a snooze subject: one item, or a row's items. */
  const itemsOf = (subject: {
    conversationId?: string;
    inboxItemId?: string;
  }) =>
    open
      .filter((i) =>
        subject.inboxItemId
          ? i.id === subject.inboxItemId
          : inRow(subject.conversationId!, i),
      )
      .map((i) => i.id);
  /**
   * When each snoozed item wakes, by item id: as on the server, a snooze
   * holds the open items of its subject, and a later item is not snoozed.
   */
  const snoozes = new Map(
    (options.snoozes ?? []).flatMap((snooze) =>
      itemsOf(snooze).map((id) => [id, snooze.untilMs] as const),
    ),
  );
  /** Snoozes made or undone, which move the versions token as on the server. */
  let snoozeChanges = 0;
  /** The items that a snooze hides now. */
  const snoozedRows = async () => {
    const nowMs = await (options.now ?? (() => NOW_MS))();
    return new Set(
      [...snoozes].flatMap(([id, untilMs]) => (untilMs > nowMs ? [id] : [])),
    );
  };
  const asleep = (sleeping: Set<string>, item: { id: string }) =>
    sleeping.has(item.id);
  await page.route("**/api/inbox/snoozes", async (route) => {
    const request = route.request();
    const body = request.postDataJSON();
    if (request.method() === "POST") {
      // One snooze per open item that it hides; it replaces the last one.
      const inboxItemIds = itemsOf(body);
      // A snooze with no time waits for its Event.
      const untilMs = body.wakeAt ? Date.parse(body.wakeAt) : Infinity;
      for (const id of inboxItemIds) snoozes.set(id, untilMs);
      snoozeChanges++;
      return route.fulfill({ json: { inboxItemIds }, status: 201 });
    }
    if (request.method() === "DELETE") {
      // Without an item, every snooze in the row wakes.
      for (const id of itemsOf(body)) snoozes.delete(id);
      snoozeChanges++;
      return route.fulfill({ status: 204 });
    }
    return route.fallback();
  });
  await page.route("**/api/versions**", async (route) => {
    const sleeping = [...(await snoozedRows())].sort().join(",");
    // The mock API's tokens stay fixed. This one also moves with snoozes.
    return route.fulfill({
      json: {
        conversationDetails: {},
        conversations: "mock",
        inboxItems: `mock:${snoozeChanges}:${sleeping}`,
        spend: "mock",
      },
    });
  });
  const archived = [answered, dismissedNotice];
  // Items closed in this test. Their detail reads closed, as on the server.
  const closedNow: MockItem[] = [];
  // A search finds snoozed and closed items too, as on the server.
  await mockSearchRows(page, {
    inboxItems: () =>
      [...open, ...closedNow, ...archived].map((i) => ({
        body: i.body,
        id: i.id,
        status:
          i.status === "open"
            ? "open"
            : i.status === "dismissed"
              ? "dismissed"
              : "done",
        title: i.title,
      })),
  });
  await page.route("**/api/inbox-items**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^.*\/api\/inbox-items/, "");
    // The tab badge counts what waits on the viewer, as the server does.
    if (path === "/count") {
      const sleeping = await snoozedRows();
      const needsViewer = open.filter(
        (i) =>
          i.kind === "action" &&
          i.canAct &&
          !i.assignedToEveryone &&
          !asleep(sleeping, i),
      );
      return route.fulfill({
        json: {
          automations: (options.automations ?? attentionCount)(),
          decisions: needsViewer.filter((i) => "request" in i && i.request)
            .length,
          needsViewer: needsViewer.length,
          codeChanges: needsViewer.filter(
            (i) =>
              i.subject?.objectType === "code_change" &&
              i.subject.kind !== "question",
          ).length,
          // One per Conversation row, as Snoozed lists them.
          snoozed: new Set(
            open.filter((i) => asleep(sleeping, i)).map((i) => i.owner.id),
          ).size,
          todos: needsViewer.filter((i) => "todoId" in i).length,
        },
      });
    }
    if (path === "" || path === "/") {
      const linked = url.searchParams.get("conversationId");
      const owner = url.searchParams.get("owner");
      const q = url.searchParams.get("q")?.toLowerCase() ?? "";
      // A status list has only closed items, newest closed first. A search
      // matches title or body, and also finds closed items after the open.
      const closed = (url.searchParams.get("status") ?? "open") !== "open";
      // The viewer's Inbox leaves out snoozed rows, and Snoozed lists only
      // them. A search and a Conversation's own list still show them.
      const sleeping = await snoozedRows();
      const forViewer = url.searchParams.get("for") === "viewer";
      const snoozedOnly = url.searchParams.get("snoozed") === "true";
      const list = (
        closed
          ? [...archived].sort((x, y) => y.closedAt.localeCompare(x.closedAt))
          : q
            ? [...open, ...archived]
            : open
      ).filter(
        (i) =>
          (!linked || i.conversationIds.includes(linked)) &&
          (!owner || i.owner.kind === owner) &&
          `${i.title}\n${i.body}`.toLowerCase().includes(q) &&
          (snoozedOnly
            ? asleep(sleeping, i)
            : !forViewer || Boolean(q || linked) || !asleep(sleeping, i)),
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
      const body = route.request().postDataJSON();
      actions.push({ body, id });
      // A take makes the viewer the only assignee, and the ask stays open.
      if (item && body?.action === "take") {
        const taken = {
          ...item,
          assignedToEveryone: false,
          assignees: [viewer],
          canTake: false,
        };
        open = open.map((i) => (i.id === id ? taken : i));
        return route.fulfill({ json: taken });
      }
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
 * Serve the viewer's code changes from their person Code overview, for
 * Code · Mine, and their live cards, with the draft state and the size.
 * Each change is in getsentry/payments and opened 30 days before the
 * report.
 */
export async function mockViewerCodeChanges(
  page: Page,
  changes: readonly {
    draft?: boolean;
    idleDays: number;
    number: number;
    size?: { additions?: number; changedFiles?: number; deletions?: number };
    stack?: {
      id: string;
      kind: "automation" | "conversation";
      title?: string;
    };
    state?: "closed" | "merged" | "open";
    title: string;
  }[],
) {
  // Like the server: 100 changes a page, in the given order, and the cursor
  // of the next page while one is left. Here the cursor is the offset.
  await page.route(/\/api\/people\/[^/]+\/code(\?.*)?$/, async (route) => {
    const report = await mockPeopleCode(route);
    const nowMs = Date.parse(report.generatedAt);
    const daysAgo = (days: number) =>
      new Date(nowMs - days * 86_400_000).toISOString();
    const offset = Number(
      new URL(route.request().url()).searchParams.get("cursor") ?? 0,
    );
    await route.fulfill({
      json: {
        ...report,
        nextCursor:
          offset + 100 < changes.length ? String(offset + 100) : undefined,
        changes: changes.slice(offset, offset + 100).map((change) => ({
          id: `00000000-0000-4000-9000-${String(change.number).padStart(12, "0")}`,
          lastActivityAt: daysAgo(change.idleDays),
          number: change.number,
          openedAt: daysAgo(30),
          provider: "github",
          repository: "getsentry/payments",
          ...(change.stack ? { stack: change.stack } : undefined),
          state: change.state ?? "open",
          title: change.title,
          url: `https://github.com/getsentry/payments/pull/${change.number}`,
        })),
      },
    });
  });
  const cards = new Map(
    changes.map((change) => {
      const label = `getsentry/payments#${change.number}`;
      const status = change.draft ? "draft" : (change.state ?? "open");
      return [
        `https://github.com/getsentry/payments/pull/${change.number}`,
        {
          displayType: "Pull request",
          facts: { type: "code_change", ...change.size },
          key: label,
          kind: "object",
          label,
          objectType: "code_change",
          plugin: "github",
          status,
          title: change.title,
        },
      ];
    }),
  );
  await page.route(/\/api\/objects\?/, async (route) => {
    const urls = new URL(route.request().url()).searchParams.getAll("url");
    if (!urls.some((url) => cards.has(url))) return route.fallback();
    const report: { objects: { object?: unknown; url: string }[] } =
      await mockObjectLinks(route);
    // The API leaves out a link it has no card for.
    await route.fulfill({
      json: {
        ...report,
        objects: urls.flatMap((url) => {
          const card = cards.get(url);
          if (card) return [{ object: { ...card, url }, url }];
          return report.objects.filter((entry) => entry.url === url);
        }),
      },
    });
  });
}

/**
 * The head of the Inbox row titled `title`. A click or Enter opens the
 * row's Conversation. On a row for one item, it expands the row in place.
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
 * row's Open action: on hover on a Conversation row, or on the open card
 * of an item row. A phone hides a closed row's actions, so there a row
 * with nothing to expand opens from its head.
 */
export async function openRow(head: Locator) {
  const row = head.locator("xpath=ancestor::*[@data-inbox-row][1]");
  // A phone opens the row in a sheet.
  const open = row
    .getByRole("link", { name: "Open conversation" })
    .or(
      head
        .page()
        .getByRole("dialog")
        .getByRole("link", { name: "Open conversation" }),
    )
    .first();
  await head.hover();
  if (!(await open.isVisible())) {
    const expand = row.locator('[aria-controls^="inbox-row-"]').first();
    if ((await expand.count()) === 0) return head.click();
    await expand.click();
  }
  await open.click();
}

/** The open row. Every row has its own quick Snooze, so scope to this one. */
export const openRowOf = (page: Page) =>
  page.locator("li[data-inbox-row][data-expanded]");

/**
 * Expand the Inbox row whose head is `head` in place: an item row with its
 * head, a Conversation row with an ask pill.
 */
export async function expandRow(head: Locator) {
  const row = head.locator("xpath=ancestor::*[@data-inbox-row][1]");
  await row.locator('[aria-controls^="inbox-row-"]').first().click();
}

/**
 * Answer that no ask waits on the viewer, so rows show their own state, as
 * the Conversation reads it.
 */
export async function noViewerWaits(page: Page) {
  await page.route(
    (url) => url.pathname === "/api/inbox-items/waiting-conversations",
    (route) => route.fulfill({ json: { conversations: [] } }),
  );
}
