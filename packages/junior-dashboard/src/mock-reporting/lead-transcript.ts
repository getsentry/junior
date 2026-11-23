import type {
  ActorIdentity,
  ConversationReportEvent,
} from "@sentry/junior/api/schema";

import { NOW_MS } from "./fixtures";

type MockEventData = ConversationReportEvent["data"];

type MockStart = { conversationId: string; task: string; title: string };

const MINUTE_MS = 60_000;

const latency: MockStart = {
  conversationId: "slack:CQA123:1770003600.000200",
  task: "Find why checkout p95 latency rose this morning and name the change that caused it.",
  title: "Investigate checkout latency",
};
const sentaur: MockStart = {
  conversationId: "slack:CQA456:1770028800.000900",
  task: "Triage the failed Sentaur GoCD deployments and get the canary healthy again.",
  title: "Triage Sentaur GoCD deployment failures",
};
const triage: MockStart = {
  conversationId: "slack:CQA123:1770000000.000100",
  task: "Triage last night's checkout latency alert.",
  title: "Checkout latency triage",
};
const deploy: MockStart = {
  conversationId: "slack:CQA777:1770014400.000500",
  task: "Find why the snuba deploy failed and whether to roll back.",
  title: "Deployment investigation failed",
};

/** The Conversations that the mock Lead still watches. */
export const MOCK_LEAD_WATCHED_CONVERSATION_IDS = [
  latency.conversationId,
  sentaur.conversationId,
];

/**
 * A mock Lead's transcript, at fixture time: two Turns that start fixture
 * Conversations in each state and watch some, then a Watch report for one
 * that needs the viewer and one that failed.
 */
export function mockLeadEvents(
  actorIdentity: ActorIdentity,
): ConversationReportEvent[] {
  const events: ConversationReportEvent[] = [];
  const push = (atMs: number, data: MockEventData) => {
    events.push({
      createdAt: new Date(atMs).toISOString(),
      data,
      seq: events.length,
    });
  };
  const turn = (args: {
    atMs: number;
    id: string;
    input: MockEventData & { type: "message" };
    reply: string;
    starts?: MockStart[];
    watches?: MockStart[];
  }) => {
    let at = args.atMs;
    const step = () => (at += 1_000);
    push(at, args.input);
    push(step(), {
      type: "turn_lifecycle",
      turnId: args.id,
      state: "started",
      inputMessageIds: [args.input.messageId],
    });
    for (const [index, start] of (args.starts ?? []).entries()) {
      const toolCallId = `${args.id}-start-${index}`;
      const startedAt = new Date(step()).toISOString();
      const startedSeq = events.length;
      push(at, {
        type: "tool_calls",
        calls: [
          {
            toolCallId,
            name: "startConversation",
            status: "running",
            startedAt,
            startedSeq,
            input: { task: start.task, title: start.title },
          },
        ],
      });
      push(step(), {
        type: "tool_calls",
        calls: [
          {
            toolCallId,
            name: "startConversation",
            status: "completed",
            startedAt,
            startedSeq,
            startedConversationId: start.conversationId,
          },
        ],
      });
    }
    for (const [index, watched] of (args.watches ?? []).entries()) {
      const toolCallId = `${args.id}-watch-${index}`;
      const startedAt = new Date(step()).toISOString();
      const startedSeq = events.length;
      push(at, {
        type: "tool_calls",
        calls: [
          {
            toolCallId,
            name: "watchEvents",
            status: "running",
            startedAt,
            startedSeq,
            input: {
              events: ["agent.update"],
              identifier: watched.conversationId,
              intent: "Tell the person when it needs them or ends.",
              label: `Conversation ${watched.title}`,
              namespace: "junior",
              resource_type: "conversation",
            },
          },
        ],
      });
      push(step(), {
        type: "tool_calls",
        calls: [
          {
            toolCallId,
            name: "watchEvents",
            status: "completed",
            startedAt,
            startedSeq,
          },
        ],
      });
    }
    push(step(), {
      type: "message",
      messageId: `${args.id}-reply`,
      role: "assistant",
      text: args.reply,
    });
    push(step(), {
      type: "turn_lifecycle",
      turnId: args.id,
      state: "succeeded",
    });
  };
  const report = (
    status: string,
    watched: MockStart,
    summary: string,
  ): MockEventData & { type: "message" } => ({
    type: "message",
    messageId: `mock-lead-${status}-${watched.conversationId}`,
    role: "user",
    eventType: "agent.update",
    eventNamespace: "junior",
    eventIdentifier: watched.conversationId,
    eventStatus: status,
    eventWatchId: `mock-lead-watch-${watched.conversationId}`,
    trustedSummary: summary,
    text: summary,
  });

  turn({
    atMs: NOW_MS - 180 * MINUTE_MS,
    id: "mock-lead-morning",
    input: {
      type: "message",
      messageId: "mock-lead-morning-request",
      role: "user",
      source: "web",
      actorIdentity,
      text: "Triage last night's checkout latency alert, and find out why the snuba deploy failed.",
    },
    reply:
      "I started both. I'm watching the deploy investigation and will tell you how it ends.",
    starts: [triage, deploy],
    watches: [deploy],
  });
  turn({
    atMs: NOW_MS - 55 * MINUTE_MS,
    id: "mock-lead-latency",
    input: {
      type: "message",
      messageId: "mock-lead-latency-request",
      role: "user",
      source: "web",
      actorIdentity,
      text: "Checkout got slow again this morning. Find out why, and triage the Sentaur GoCD failures. Tell me when either needs me.",
    },
    reply:
      "Started both and watching them. I'll report back here when one needs you or finishes.",
    starts: [latency, sentaur],
    watches: [latency, sentaur],
  });
  turn({
    atMs: NOW_MS - 36 * MINUTE_MS,
    id: "mock-lead-sentaur-waiting",
    input: report(
      "waiting",
      sentaur,
      `"${sentaur.title}" waits on the person.`,
    ),
    reply:
      "The Sentaur triage wants your approval to restart the stuck canary agents. It has four more questions after that.",
  });
  turn({
    atMs: NOW_MS - 35 * MINUTE_MS,
    id: "mock-lead-deploy-failed",
    input: report("failed", deploy, `"${deploy.title}" failed.`),
    reply:
      "The deploy investigation failed: it lost access to the GoCD API halfway through. Tell me if you want it retried.",
  });
  return events;
}
