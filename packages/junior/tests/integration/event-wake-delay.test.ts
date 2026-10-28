import { afterEach, describe, expect, it, vi } from "vitest";
import { enqueueEventNotification } from "@/chat/events/notification";
import { createWatch } from "@/chat/events/store";
import type { AgentRun } from "@/chat/agent/types";
import { getConversationEventStore } from "@/chat/db";
import {
  appendAndEnqueueWebMessage,
  createConversationId,
  recordWebConversationActivity,
} from "@/chat/conversations/web-input";
import {
  resolveMailboxTurnWork,
  type MailboxTurnWork,
} from "@/chat/task-execution/mailbox-turn";
import { createConversationTurnWorker } from "@/chat/task-execution/conversation-turn";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import type {
  ConversationWorkerContext,
  ConversationWorkerResult,
} from "@/chat/task-execution/worker";
import {
  closeConversationFixture,
  createConversationFixture,
} from "../fixtures/conversation";
import { createModelAgentRunnerForRun } from "../fixtures/agent-runner";
import { createModelStream } from "../fixtures/model-stream";

function requireConversationTurn(
  worker: (
    context: ConversationWorkerContext,
    resolved: MailboxTurnWork,
  ) => Promise<ConversationWorkerResult>,
) {
  return async (
    context: ConversationWorkerContext,
  ): Promise<ConversationWorkerResult> => {
    const resolved = await resolveMailboxTurnWork(context);
    if (!resolved) throw new Error("Expected Conversation mailbox work");
    return await worker(context, resolved);
  };
}

describe("event wake delay", () => {
  afterEach(async () => {
    await closeConversationFixture();
    vi.restoreAllMocks();
  });

  it("waits for a burst of events before running one Turn", async () => {
    const { actor, conversationStore, queue, state } =
      await createConversationFixture();
    const conversationId = createConversationId({
      actorEmail: actor.email,
      idempotencyKey: "event-burst-1",
    });
    await recordWebConversationActivity({
      actor,
      conversationId,
      conversationStore,
      nowMs: 1,
    });
    await conversationStore.recordActivity({
      activityAtMs: 1,
      conversationId,
      nowMs: 1,
      title: "Events",
    });

    const baseMs = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(baseMs);
    const watch = (input: {
      events: string[];
      guidance?: Record<string, string>;
      identifier: string;
      intent: string;
      label: string;
      namespace: string;
      resourceType: string;
    }) =>
      createWatch(
        { conversationId, expiresAtMs: baseMs + 3_600_000, ...input },
        { nowMs: baseMs, state },
      );
    const prWatch = await watch({
      events: [
        "pull_request.review.approved",
        "pull_request.review_comment.created",
      ],
      guidance: {
        "pull_request.review_comment.created": "Reply on the thread.",
      },
      identifier: "getsentry/junior#2245",
      intent: "Maintain this pull request.",
      label: "GitHub PR getsentry/junior#2245",
      namespace: "github",
      resourceType: "pull_request",
    });
    // A second Watch on the same PR keeps its own instructions.
    const releaseWatch = await watch({
      events: ["pull_request.merged"],
      identifier: "getsentry/junior#2245",
      intent: "Post release notes after merge.",
      label: "GitHub PR getsentry/junior#2245",
      namespace: "github",
      resourceType: "pull_request",
    });
    const deployWatch = await watch({
      events: ["deployment.succeeded"],
      identifier: "prj_junior:production",
      intent: "Report deploy results.",
      label: "Vercel deployment junior-prod",
      namespace: "vercel",
      resourceType: "deployment",
    });
    const notify = (
      subscription: typeof prWatch,
      eventKey: string,
      eventType: string,
      trustedSummary: string,
      people?: string[],
    ) =>
      enqueueEventNotification({
        doneBy: people ? { handle: "dcramer", mention: people[0]! } : undefined,
        event: {
          eventKey,
          eventType,
          identifier: subscription.identifier,
          namespace: subscription.namespace,
          occurredAtMs: Date.now(),
          trustedSummary,
        },
        people,
        queue,
        state,
        subscription,
      });

    await notify(
      prWatch,
      "github:delivery-1:pull_request.review.approved",
      "pull_request.review.approved",
      "Approved by dcramer.",
      ["<@U123>"],
    );
    expect(queue.sentRecords()).toEqual([
      expect.objectContaining({ delayMs: 30_000 }),
    ]);

    const agentRuns: AgentRun[] = [];
    const run = requireConversationTurn(
      createConversationTurnWorker(
        createModelAgentRunnerForRun((agentRun) => {
          agentRuns.push(agentRun);
          return createModelStream([
            { type: "text", text: "Handled the events." },
          ]);
        }),
      ),
    );
    const processNext = () =>
      processConversationQueueMessage(queue.takeMessage(), {
        conversationStore,
        queue,
        run,
        state,
      });

    // A person's message runs now. The Event keeps waiting.
    nowSpy.mockReturnValue(baseMs + 100);
    await appendAndEnqueueWebMessage(
      {
        actor,
        conversationId,
        idempotencyKey: "human-message",
        message: "Please check now",
      },
      { conversationStore, queue, state },
    );
    await expect(processNext()).resolves.toEqual({
      status: "pending_requeued",
    });
    expect(agentRuns).toHaveLength(1);

    // Events from other Watches and providers join the same wait window.
    nowSpy.mockReturnValue(baseMs + 200);
    await notify(
      deployWatch,
      "vercel:hook-1:deployment.succeeded",
      "deployment.succeeded",
      "Deployment dpl_1 succeeded.",
    );
    nowSpy.mockReturnValue(baseMs + 300);
    await notify(
      prWatch,
      "github:delivery-2:pull_request.review_comment.created",
      "pull_request.review_comment.created",
      "Inline comment from cursor[bot].",
    );
    nowSpy.mockReturnValue(baseMs + 400);
    await notify(
      releaseWatch,
      "github:delivery-3:pull_request.merged",
      "pull_request.merged",
      "Merged by dcramer.",
    );
    // A repeated delivery of the same Event for the same Watch is dropped.
    await expect(
      notify(
        prWatch,
        "github:delivery-1:pull_request.review.approved",
        "pull_request.review.approved",
        "Approved by dcramer.",
      ),
    ).resolves.toMatchObject({ status: "duplicate" });

    // Each extra Event adds 5s to the 30s wait.
    nowSpy.mockReturnValue(baseMs + 30_000);
    await expect(processNext()).resolves.toEqual({
      status: "pending_requeued",
    });
    expect(agentRuns).toHaveLength(1);
    expect(queue.sentRecords().at(-1)).toMatchObject({ delayMs: 15_000 });

    nowSpy.mockReturnValue(baseMs + 45_000);
    await expect(processNext()).resolves.toEqual({ status: "completed" });
    expect(agentRuns).toHaveLength(2);

    const savedEvents =
      await getConversationEventStore().loadHistory(conversationId);
    const userMessages = savedEvents.flatMap((event) =>
      event.data.type === "message" && event.data.role === "user"
        ? [event.data]
        : [],
    );
    expect(userMessages.map((message) => message.text)[0]).toBe(
      "Please check now",
    );
    expect(userMessages).toHaveLength(2);
    // The one message lists every Event, not only the first.
    expect(userMessages[1]!.meta?.events).toEqual([
      expect.objectContaining({
        eventType: "pull_request.review.approved",
        label: prWatch.label,
        trustedSummary: "Approved by dcramer.",
      }),
      expect.objectContaining({
        eventType: "deployment.succeeded",
        label: deployWatch.label,
      }),
      expect.objectContaining({
        eventType: "pull_request.review_comment.created",
        label: prWatch.label,
      }),
      expect.objectContaining({
        eventType: "pull_request.merged",
        label: releaseWatch.label,
      }),
    ]);
    // Each Watch states its instructions once and keeps its Events together.
    const text = userMessages[1]!.text;
    expect(text).toContain("You received 4 events.");
    expect(text.match(/Instructions: /g)).toHaveLength(3);
    expect(text).toContain(
      [
        `About: ${prWatch.label}`,
        "People involved: <@U123>",
        `Instructions: ${prWatch.intent}`,
      ].join("\n"),
    );
    expect(text).toContain(
      "- pull_request.review_comment.created: Reply on the thread.",
    );
    expect(text).toMatch(
      /Event 1: pull_request\.review\.approved\nDone by: <@U123>\. [^\n]*"dcramer"[^\n]*\nTrusted summary: Approved by dcramer\.\n\nEvent 2: pull_request\.review_comment\.created/,
    );
    expect(text).toContain(
      [
        `About: ${deployWatch.label}`,
        `Instructions: ${deployWatch.intent}`,
        "",
        "Event 3: deployment.succeeded",
      ].join("\n"),
    );
    expect(text).toContain(
      [
        `Instructions: ${releaseWatch.intent}`,
        "",
        "Event 4: pull_request.merged",
      ].join("\n"),
    );
  });
});
