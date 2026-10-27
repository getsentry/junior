import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEventInboundMessage,
  EVENT_WAIT_MS,
} from "@/chat/events/notification";
import type { AgentRun } from "@/chat/agent/types";
import { renderTaskInput } from "@/chat/task-input";
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
import { appendAndEnqueueInboundMessage } from "@/chat/task-execution/store";
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
    const subscription = {
      conversationId,
      id: "resource-subscription-burst",
    };
    const eventMessage = (sequence: number, receivedAtMs: number) => {
      const task = {
        about: "GitHub PR getsentry/junior#1563",
        instructions: "Fix failed checks on this PR.",
        trustedSummary: `Check ${sequence} failed`,
      };
      return createEventInboundMessage({
        event: {
          eventKey: `check-${sequence}`,
          eventType: "check_suite.completed",
          objectType: "code_change",
          identifier: "getsentry/junior#1563",
          namespace: "github",
          occurredAtMs: receivedAtMs,
          trustedSummary: `Check ${sequence} failed`,
        },
        receivedAtMs,
        subscription,
        task,
        text: renderTaskInput(task),
      });
    };

    await appendAndEnqueueInboundMessage({
      conversationStore,
      message: eventMessage(1, baseMs),
      queue,
      queueDelayMs: EVENT_WAIT_MS,
      state,
    });
    expect(queue.sentRecords()).toEqual([
      expect.objectContaining({ delayMs: 30_000 }),
    ]);

    const agentRuns: AgentRun[] = [];
    const run = requireConversationTurn(
      createConversationTurnWorker(
        createModelAgentRunnerForRun((agentRun) => {
          agentRuns.push(agentRun);
          return createModelStream([
            { type: "text", text: "Handled both events." },
          ]);
        }),
      ),
    );

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
    expect(queue.sentRecords()).toHaveLength(2);
    await expect(
      processConversationQueueMessage(queue.takeMessage(), {
        conversationStore,
        queue,
        run,
        state,
      }),
    ).resolves.toEqual({ status: "pending_requeued" });
    expect(agentRuns).toHaveLength(1);

    nowSpy.mockReturnValue(baseMs + 200);
    await appendAndEnqueueInboundMessage({
      conversationStore,
      message: eventMessage(2, baseMs + 200),
      queue,
      state,
    });
    expect(queue.sentRecords()).toHaveLength(3);

    nowSpy.mockReturnValue(baseMs + 30_000);
    await expect(
      processConversationQueueMessage(queue.takeMessage(), {
        conversationStore,
        queue,
        run,
        state,
      }),
    ).resolves.toEqual({ status: "pending_requeued" });
    expect(agentRuns).toHaveLength(1);
    expect(queue.sentRecords().at(-1)).toMatchObject({ delayMs: 5_000 });

    nowSpy.mockReturnValue(baseMs + 35_000);
    await expect(
      processConversationQueueMessage(queue.takeMessage(), {
        conversationStore,
        queue,
        run,
        state,
      }),
    ).resolves.toEqual({ status: "completed" });
    expect(agentRuns).toHaveLength(2);

    const savedEvents =
      await getConversationEventStore().loadHistory(conversationId);
    // Both Events are listed on the one message, not only the first.
    expect(
      savedEvents.find(
        (event) =>
          event.data.type === "message" &&
          event.data.meta?.eventType === "check_suite.completed",
      )?.data,
    ).toMatchObject({
      meta: {
        eventObjectType: "code_change",
        events: [
          {
            eventType: "check_suite.completed",
            label: "GitHub PR getsentry/junior#1563",
            trustedSummary: "Check 1 failed",
          },
          {
            eventType: "check_suite.completed",
            label: "GitHub PR getsentry/junior#1563",
            trustedSummary: "Check 2 failed",
          },
        ],
      },
    });
    const userMessages = savedEvents.flatMap((event) =>
      event.data.type === "message" && event.data.role === "user"
        ? [event.data.text]
        : [],
    );
    expect(userMessages).toHaveLength(2);
    expect(userMessages[0]).toBe("Please check now");
    // One task message states the instructions once for both Events.
    const batchText = userMessages[1]!;
    expect(batchText).toContain("You received 2 events.");
    expect(batchText.match(/Instructions: /g)).toHaveLength(1);
    expect(batchText).toContain(
      "Event 1: check_suite.completed\nTrusted summary: Check 1 failed",
    );
    expect(batchText).toContain(
      "Event 2: check_suite.completed\nTrusted summary: Check 2 failed",
    );
  });

  it("merges Events from different Watches into one task message", async () => {
    const { actor, conversationStore, queue, state } =
      await createConversationFixture();
    const conversationId = createConversationId({
      actorEmail: actor.email,
      idempotencyKey: "event-mixed-1",
    });
    await recordWebConversationActivity({
      actor,
      conversationId,
      conversationStore,
      nowMs: 1,
    });

    const baseMs = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(baseMs);
    const prWatch = {
      about: "GitHub PR getsentry/junior#2245",
      id: "watch-pr-maintain",
      identifier: "getsentry/junior#2245",
      instructions: "Maintain this pull request.",
      namespace: "github",
    };
    // A second Watch on the same PR has its own instructions.
    const prReleaseWatch = {
      ...prWatch,
      id: "watch-pr-release",
      instructions: "Post release notes after merge.",
    };
    const deployWatch = {
      about: "Vercel deployment junior-prod (production)",
      id: "watch-deploy",
      identifier: "prj_junior:production",
      instructions: "Report deploy results.",
      namespace: "vercel",
    };
    const eventMessage = (
      watch: typeof prWatch,
      eventKey: string,
      eventType: string,
      trustedSummary: string,
      receivedAtMs: number,
    ) => {
      const task = {
        about: watch.about,
        instructions: watch.instructions,
        trustedSummary,
      };
      return createEventInboundMessage({
        event: {
          eventKey,
          eventType,
          identifier: watch.identifier,
          namespace: watch.namespace,
          occurredAtMs: receivedAtMs,
          trustedSummary,
        },
        receivedAtMs,
        subscription: { conversationId, id: watch.id },
        task,
        text: renderTaskInput(task),
      });
    };
    const messages = [
      eventMessage(
        prWatch,
        "github:delivery-1:pull_request.review.approved",
        "pull_request.review.approved",
        "Approved by dcramer.",
        baseMs,
      ),
      eventMessage(
        deployWatch,
        "vercel:hook-1:deployment.succeeded",
        "deployment.succeeded",
        "Deployment dpl_1 succeeded.",
        baseMs + 100,
      ),
      eventMessage(
        prWatch,
        "github:delivery-2:pull_request.review_comment.created",
        "pull_request.review_comment.created",
        "Inline comment from cursor[bot].",
        baseMs + 200,
      ),
      eventMessage(
        prReleaseWatch,
        "github:delivery-3:pull_request.merged",
        "pull_request.merged",
        "Merged by dcramer.",
        baseMs + 300,
      ),
    ];
    for (const message of messages) {
      nowSpy.mockReturnValue(message.receivedAtMs);
      await appendAndEnqueueInboundMessage({
        conversationStore,
        message,
        queue,
        queueDelayMs: EVENT_WAIT_MS,
        state,
      });
    }
    // A repeated delivery of the same Event for the same Watch is dropped.
    nowSpy.mockReturnValue(baseMs + 400);
    await expect(
      appendAndEnqueueInboundMessage({
        conversationStore,
        message: messages[0]!,
        queue,
        queueDelayMs: EVENT_WAIT_MS,
        state,
      }),
    ).resolves.toMatchObject({ status: "duplicate" });

    const agentRuns: AgentRun[] = [];
    const run = requireConversationTurn(
      createConversationTurnWorker(
        createModelAgentRunnerForRun((agentRun) => {
          agentRuns.push(agentRun);
          return createModelStream([{ type: "text", text: "Handled." }]);
        }),
      ),
    );
    nowSpy.mockReturnValue(baseMs + 60_000);
    let status: string | undefined;
    while (status !== "completed" && queue.sentRecords().length > 0) {
      ({ status } = await processConversationQueueMessage(queue.takeMessage(), {
        conversationStore,
        queue,
        run,
        state,
      }));
    }
    expect(status).toBe("completed");
    expect(agentRuns).toHaveLength(1);

    const savedEvents =
      await getConversationEventStore().loadHistory(conversationId);
    const userMessages = savedEvents.flatMap((event) =>
      event.data.type === "message" && event.data.role === "user"
        ? [event.data]
        : [],
    );
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]!.meta?.events).toEqual([
      expect.objectContaining({
        eventType: "pull_request.review.approved",
        label: prWatch.about,
      }),
      expect.objectContaining({
        eventType: "deployment.succeeded",
        label: deployWatch.about,
      }),
      expect.objectContaining({
        eventType: "pull_request.review_comment.created",
        label: prWatch.about,
      }),
      expect.objectContaining({
        eventType: "pull_request.merged",
        label: prWatch.about,
      }),
    ]);
    // Each Watch keeps its own instructions, and its Events stay together.
    const text = userMessages[0]!.text;
    expect(text).toContain("You received 4 events.");
    expect(text.match(/Instructions: /g)).toHaveLength(3);
    expect(text).toContain(
      [
        `About: ${prWatch.about}`,
        `Instructions: ${prWatch.instructions}`,
        "",
        "Event 1: pull_request.review.approved",
        "Trusted summary: Approved by dcramer.",
        "",
        "Event 2: pull_request.review_comment.created",
      ].join("\n"),
    );
    expect(text).toContain(
      [
        `About: ${deployWatch.about}`,
        `Instructions: ${deployWatch.instructions}`,
        "",
        "Event 3: deployment.succeeded",
      ].join("\n"),
    );
    expect(text).toContain(
      [
        `About: ${prReleaseWatch.about}`,
        `Instructions: ${prReleaseWatch.instructions}`,
        "",
        "Event 4: pull_request.merged",
      ].join("\n"),
    );
  });
});
