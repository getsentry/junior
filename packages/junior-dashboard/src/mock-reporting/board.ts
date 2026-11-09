import type {
  ActorIdentity,
  BoardCard,
  BoardReport,
} from "@sentry/junior/api/schema";

import { DASHBOARD_QA_CONVERSATION_ID } from "./fixtures";

const HOUR_MS = 60 * 60 * 1_000;
const CHECKOUT = {
  conversationId: "slack:CQA123:1770003600.000200",
  title: "Investigate checkout latency",
};
const RELEASE = {
  conversationId: "slack:CQA456:1770021600.000600",
  title: "Package release and self-update",
};
const QA = {
  conversationId: DASHBOARD_QA_CONVERSATION_ID,
  title: "Dashboard QA edge cases",
};

const MORGAN: ActorIdentity = {
  email: "morgan@example.com",
  fullName: "Morgan Lee",
  slackUserName: "morgan",
};
const CASEY: ActorIdentity = { fullName: "Casey Nguyen", slackUserId: "U456" };

function card(
  nowMs: number,
  input: Omit<
    BoardCard,
    "needsViewer" | "participants" | "updatedAt" | "working"
  > & {
    ageHours: number;
    needsViewer?: boolean;
    participants?: ActorIdentity[];
    working?: boolean;
  },
): BoardCard {
  const { ageHours, ...rest } = input;
  return {
    needsViewer: false,
    participants: [MORGAN],
    updatedAt: new Date(nowMs - ageHours * HOUR_MS).toISOString(),
    working: false,
    ...rest,
  };
}

function pull(repository: string, number: number) {
  return {
    label: `${repository}#${number}`,
    url: `https://github.com/${repository}/pull/${number}`,
  };
}

function issue(repository: string, number: number) {
  return {
    label: `${repository}#${number}`,
    url: `https://github.com/${repository}/issues/${number}`,
  };
}

/**
 * Return a mock Board with each column and card label in use. Times are
 * relative to `nowMs`, so Done stays inside its window.
 */
export function readMockBoard(nowMs: number): BoardReport {
  return {
    cards: [
      card(nowMs, {
        ...pull("getsentry/junior", 2440),
        ageHours: 0.2,
        column: "in_progress",
        conversation: {
          conversationId: QA.conversationId,
          rootTitle: QA.title,
          title: "Board layout",
        },
        key: "code_change:2440",
        objectType: "code_change",
        status: "open",
        title: "Board: kanban view of Conversation work at /board",
        working: true,
      }),
      card(nowMs, {
        ...pull("getsentry/junior", 2433),
        ageHours: 0.6,
        column: "ready",
        conversation: RELEASE,
        key: "code_change:2433",
        objectType: "code_change",
        participants: [MORGAN, CASEY],
        status: "open",
        title: "Retry Slack file uploads once on 503",
      }),
      card(nowMs, {
        ...pull("getsentry/junior", 2428),
        ageHours: 1,
        column: "done",
        conversation: QA,
        key: "code_change:2428",
        objectType: "code_change",
        status: "merged",
        title: "Fix duplicate avatars in the participant stack",
      }),
      card(nowMs, {
        ...issue("getsentry/junior", 2431),
        ageHours: 2,
        column: "planned",
        conversation: CHECKOUT,
        key: "ticket:github:getsentry/junior#2431",
        objectType: "task",
        participants: [MORGAN, CASEY],
        status: "open",
        title: "Slack thread replies lose attachments after a steering message",
      }),
      card(nowMs, {
        ...pull("getsentry/payments", 812),
        ageHours: 3,
        column: "in_progress",
        conversation: CHECKOUT,
        key: "code_change:812",
        needsViewer: true,
        objectType: "code_change",
        status: "open",
        title: "Cache the tax lookup for checkout totals",
      }),
      card(nowMs, {
        ...issue("getsentry/junior", 2419),
        ageHours: 4,
        column: "done",
        conversation: RELEASE,
        key: "ticket:github:getsentry/junior#2419",
        objectType: "task",
        status: "closed",
        title: "Self-update skips plugin packages",
      }),
      card(nowMs, {
        ...issue("getsentry/sentry", 88214),
        ageHours: 26,
        column: "planned",
        conversation: QA,
        key: "ticket:github:getsentry/sentry#88214",
        objectType: "task",
        status: "open",
        title:
          "Spans explorer: sort by p95 resets after changing the time range",
      }),
    ],
    doneWindowHours: 6,
  };
}
