import { describe, expect, it, vi } from "vitest";
import {
  getSlackContinuationMarker,
  getSlackInterruptionMarker,
  slackOutputPolicy,
} from "@/chat/slack/output";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import {
  createTestMessage,
  createTestThread,
  createTestDestination,
} from "../../fixtures/slack-harness";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";
import { flattenAgentRunRequestForTest } from "../../fixtures/agent-runner";
import { TurnInputDeferredError } from "@/chat/runtime/turn";
import {
  listAgentTurnSessionSummariesForConversation,
  listBoundedAgentTurnSessionSummariesForConversation,
} from "@/chat/state/turn-session";

function toPostedText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object") {
    const markdown = (value as { markdown?: unknown }).markdown;
    if (typeof markdown === "string") {
      return markdown;
    }
    const raw = (value as { raw?: unknown }).raw;
    if (typeof raw === "string") {
      return raw;
    }
    if ("files" in value) {
      return "";
    }
  }

  return String(value);
}

function makeDiagnostics(
  overrides: Partial<{
    outcome: "success" | "execution_failure" | "provider_error";
    toolCalls: string[];
  }> = {},
) {
  return {
    assistantMessageCount: 1,
    modelId: "fake-agent-model",
    outcome: overrides.outcome ?? ("success" as const),
    toolCalls: overrides.toolCalls ?? [],
    toolErrorCount: 0,
    toolResultCount: (overrides.toolCalls ?? []).length,
    usedPrimaryText: true,
  };
}

describe("Slack behavior: finalized thread replies", () => {
  it("posts only the finalized assistant reply even when deltas were emitted", async () => {
    const turnLifecycle = {
      complete: vi.fn(),
      fail: vi.fn(),
      start: vi.fn(),
    };
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          turnLifecycle,
          agentRunner: {
            run: async (request) => {
              const _prompt = request.input.messageText;
              const context = {
                ...flattenAgentRunRequestForTest(request),
              };

              await context?.onTextDelta?.("Hello ");
              await context?.onTextDelta?.("world");
              return completedAgentRun({
                text: "Hello world",
                diagnostics: makeDiagnostics(),
              });
            },
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C0FINAL:1700006000.000" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-final-1",
        text: "<@U0APP> say hello",
        isMention: true,
        threadId: thread.id,
      }),
      { destination: createTestDestination(thread) },
    );

    expect(thread.postKinds).toEqual(["value"]);
    expect(thread.posts.map(toPostedText)).toEqual(["Hello world"]);
    expect(turnLifecycle.start).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: thread.id,
        inputMessageIds: ["m-final-1"],
        surface: "slack",
      }),
    );
    expect(turnLifecycle.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: thread.id,
        outcome: "success",
      }),
    );
    expect(turnLifecycle.fail).not.toHaveBeenCalled();
  });

  it("drops provisional pre-tool deltas and posts the post-tool answer once", async () => {
    const finalReply =
      "I checked five outlets. The dominant story is the escalating US-Iran conflict.";
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async (request) => {
              const _prompt = request.input.messageText;
              const context = {
                ...flattenAgentRunRequestForTest(request),
              };

              await context?.onTextDelta?.("Fetching sources now...");
              await context?.onAssistantMessageStart?.();
              await context?.onTextDelta?.(finalReply);
              return completedAgentRun({
                text: finalReply,
                diagnostics: makeDiagnostics({ toolCalls: ["webSearch"] }),
              });
            },
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C0FINAL:1700006001.000" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-final-2",
        text: "<@U0APP> summarize the news",
        isMention: true,
        threadId: thread.id,
      }),
      { destination: createTestDestination(thread) },
    );

    expect(thread.postKinds).toEqual(["value"]);
    expect(thread.posts.map(toPostedText)).toEqual([finalReply]);
  });

  it("posts a failure fallback instead of completing an empty final post plan", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async () =>
              completedAgentRun({
                text: "",
                deliveryPlan: {
                  mode: "thread",
                  postThreadText: true,
                },
                diagnostics: makeDiagnostics(),
              }),
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C0FINAL:1700006005.000" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-final-empty-plan",
        text: "<@U0APP> reply invisibly",
        isMention: true,
        threadId: thread.id,
      }),
      { destination: createTestDestination(thread), isFinalAttempt: true },
    );

    expect(thread.postKinds).toEqual(["value"]);
    expect(toPostedText(thread.posts[0])).toContain(
      "I ran into an internal error while processing that.",
    );
  });

  it("splits long replies into continuation posts after the final reply is known", async () => {
    const longReply = Array.from(
      { length: 80 },
      (_, i) => `line ${i + 1}`,
    ).join("\n");
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async () =>
              completedAgentRun({
                text: longReply,
                diagnostics: makeDiagnostics(),
              }),
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C0FINAL:1700006005.000" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-final-6",
        text: "<@U0APP> give me all lines",
        isMention: true,
        threadId: thread.id,
      }),
      { destination: createTestDestination(thread) },
    );

    expect(thread.postKinds.every((kind) => kind === "value")).toBe(true);
    expect(thread.posts.length).toBeGreaterThan(1);
    expect(
      toPostedText(thread.posts[0]).endsWith(getSlackContinuationMarker()),
    ).toBe(true);
    expect(toPostedText(thread.posts.at(-1))).not.toContain(
      getSlackContinuationMarker(),
    );
  });

  it("preserves fenced code blocks across continuation posts", async () => {
    const repeated = "console.log('hello');\n".repeat(200);
    const longReply = `Here is the script:\n\`\`\`ts\n${repeated}\`\`\``;
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async () =>
              completedAgentRun({
                text: longReply,
                diagnostics: makeDiagnostics(),
              }),
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C0FINAL:1700006006.000" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-final-7",
        text: "<@U0APP> send the script",
        isMention: true,
        threadId: thread.id,
      }),
      { destination: createTestDestination(thread) },
    );

    expect(thread.posts.length).toBeGreaterThan(1);
    const firstPost = toPostedText(thread.posts[0]);
    const secondPost = toPostedText(thread.posts[1]);

    expect(firstPost.endsWith(`\n\`\`\`${getSlackContinuationMarker()}`)).toBe(
      true,
    );
    expect(secondPost.startsWith("```ts\n")).toBe(true);
  });

  it("marks provider-error replies with partial text as interrupted", async () => {
    const partialStart = "The budget review is complete.";
    const partialEnd = "This should continue into a second post.";
    const longReply = `${partialStart} ${"A".repeat(slackOutputPolicy.maxInlineChars)}\n\n${partialEnd}`;
    const turnLifecycle = {
      complete: vi.fn(),
      fail: vi.fn(),
      start: vi.fn(),
    };
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          turnLifecycle,
          agentRunner: {
            run: async () =>
              completedAgentRun({
                text: longReply,
                diagnostics: makeDiagnostics({ outcome: "provider_error" }),
              }),
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C0FINAL:1700006007.000" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-final-8",
        text: "<@U0APP> long reply please",
        isMention: true,
        threadId: thread.id,
      }),
      { destination: createTestDestination(thread) },
    );

    expect(thread.postKinds.every((kind) => kind === "value")).toBe(true);
    expect(thread.posts.length).toBeGreaterThan(1);
    const postedText = thread.posts.map(toPostedText).join("\n");
    expect(postedText).toContain(partialStart);
    expect(postedText).toContain(partialEnd);
    expect(postedText).toContain(getSlackInterruptionMarker().trim());
    expect(postedText).not.toContain("event_id=");
    expect(turnLifecycle.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: thread.id,
        eventId: expect.stringMatching(/^[a-f0-9]{32}$/i),
        failureCode: "model_execution_failed",
      }),
    );
    expect(turnLifecycle.complete).not.toHaveBeenCalled();
  });

  it("recovers a pending concrete Slack delivery without rerunning Pi", async () => {
    const run = vi.fn(async () =>
      completedAgentRun({
        text: "Recovered exactly once",
        piMessages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Recovered exactly once" }],
          },
        ] as never,
        diagnostics: makeDiagnostics(),
      }),
    );
    let pending: unknown;
    let advances = 0;
    const scheduleSessionCompletedPluginTasks = vi.fn();
    const recoverableSlackDelivery = {
      loadByTurn: vi.fn(async () => pending as never),
      loadOldestByConversation: vi.fn(async () => pending as never),
      loadTerminalOutcome: vi.fn(async () => undefined),
      loadTurnTerminalOutcome: vi.fn(async () => undefined),
      createIntent: vi.fn(async (args) => {
        pending = {
          ...args,
          nextAttemptAtMs: Date.now(),
          command: args.command,
        };
        return pending as never;
      }),
      advance: vi.fn(async () => {
        advances += 1;
        if (advances === 1) {
          return { outcome: "pending" as const, retryAtMs: Date.now() };
        }
        pending = undefined;
        return { outcome: "accepted" as const };
      }),
    };
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: { run },
          recoverableSlackDelivery,
          scheduleSessionCompletedPluginTasks,
        },
      },
    });
    const thread = createTestThread({
      id: "slack:C0FINAL:1700006008.000",
    });
    (thread as unknown as { adapter: { name: string } }).adapter = {
      name: "slack",
    };
    const message = createTestMessage({
      id: "m-final-recovery",
      text: "<@U0APP> recover me",
      isMention: true,
      threadId: thread.id,
    });

    await expect(
      slackRuntime.handleNewMention(thread, message, {
        destination: createTestDestination(thread),
        isFinalAttempt: false,
      }),
    ).rejects.toBeInstanceOf(TurnInputDeferredError);
    await expect(
      slackRuntime.handleNewMention(thread, message, {
        destination: createTestDestination(thread),
        isFinalAttempt: false,
      }),
    ).resolves.toBeUndefined();

    expect(run).toHaveBeenCalledTimes(1);
    expect(recoverableSlackDelivery.createIntent).toHaveBeenCalledTimes(1);
    expect(recoverableSlackDelivery.advance).toHaveBeenCalledTimes(2);
    expect(scheduleSessionCompletedPluginTasks).toHaveBeenCalledOnce();
    expect(
      (await listAgentTurnSessionSummariesForConversation(thread.id)).find(
        (summary) => summary.sessionId === "turn_m-final-recovery",
      )?.state,
    ).toBe("completed");
    expect(thread.posts).toEqual([]);
  });

  it("recovers an older delivery before newer input and partially acknowledges it", async () => {
    const run = vi.fn();
    const thread = createTestThread({
      id: "slack:C0FINAL:1700006009.000",
    });
    const destination = createTestDestination(thread);
    if (destination.platform !== "slack") {
      throw new Error("Expected Slack destination");
    }
    const older = {
      conversationId: thread.id,
      deliveryId: "slack:turn_old-message",
      turnId: "turn_old-message",
      command: {
        completion: {
          inputMessageIds: ["old-message"],
          model: { modelId: "fake-agent-model" },
          sliceId: 1,
          terminal: { outcome: "success" },
        },
        session: {
          source: {
            platform: "slack",
            teamId: destination.teamId,
            channelId: destination.channelId,
            messageTs: "1700006009.000",
            threadTs: "1700006009.000",
          },
          destination,
          startedAtMs: 1_000,
        },
      },
    } as never;
    const ack = vi.fn();
    const ackMessageIds = vi.fn();
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: { run },
          recoverableSlackDelivery: {
            loadOldestByConversation: vi.fn(async () => older),
            loadByTurn: vi.fn(async () => older),
            loadTerminalOutcome: vi.fn(async () => undefined),
            loadTurnTerminalOutcome: vi.fn(async () => undefined),
            createIntent: vi.fn(),
            advance: vi.fn(async () => ({ outcome: "accepted" as const })),
          },
          scheduleSessionCompletedPluginTasks: vi.fn(),
        },
      },
    });
    const next = createTestMessage({
      id: "new-message",
      text: "<@U0APP> newer input",
      isMention: true,
      threadId: thread.id,
    });

    const error = await slackRuntime
      .handleNewMention(thread, next, {
        destination,
        isFinalAttempt: false,
        ack,
        ackMessageIds,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TurnInputDeferredError);
    expect((error as TurnInputDeferredError).immediate).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
    expect(ackMessageIds).toHaveBeenCalledWith(["old-message"]);
  });

  it("acknowledges an accepted terminal even when Redis repair fails", async () => {
    const thread = createTestThread({
      id: "slack:C0FINAL:1700006012.000",
    });
    const destination = createTestDestination(thread);
    const pending = {
      conversationId: thread.id,
      deliveryId: "slack:turn_redis-repair",
      turnId: "turn_redis-repair",
      nextAttemptAtMs: Date.now(),
      command: {
        completion: {
          inputMessageIds: ["redis-repair"],
          model: { modelId: "fake-agent-model" },
          sliceId: 1,
          terminal: { outcome: "success" },
        },
        session: {
          surface: "slack",
          source: {
            platform: "slack",
            teamId: "TTEST",
            channelId: "C0FINAL",
          },
          destination,
          startedAtMs: 1_000,
        },
      },
    } as never;
    const ack = vi.fn();
    const run = vi.fn();
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: { run },
          recoverableSlackDelivery: {
            loadOldestByConversation: vi.fn(async () => pending),
            loadByTurn: vi.fn(async () => pending),
            loadTerminalOutcome: vi.fn(async () => undefined),
            loadTurnTerminalOutcome: vi.fn(async () => "success" as const),
            createIntent: vi.fn(),
            advance: vi.fn(async () => ({ outcome: "accepted" as const })),
          },
        },
      },
    });
    thread.setState = vi.fn(async () => {
      throw new Error("Redis unavailable");
    });

    await expect(
      slackRuntime.handleNewMention(
        thread,
        createTestMessage({
          id: "redis-repair",
          text: "<@U0APP> recover",
          isMention: true,
          threadId: thread.id,
        }),
        { destination, ack, isFinalAttempt: true },
      ),
    ).resolves.toBeUndefined();

    expect(run).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledOnce();
    expect(thread.posts).toEqual([]);
  });

  it("repairs session and plugin state from a row-deleted accepted terminal", async () => {
    const thread = createTestThread({
      id: "slack:C0FINAL:1700006013.000",
    });
    const ack = vi.fn();
    const run = vi.fn();
    const scheduleSessionCompletedPluginTasks = vi.fn();
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: { run },
          recoverableSlackDelivery: {
            loadOldestByConversation: vi.fn(async () => undefined),
            loadByTurn: vi.fn(async () => undefined),
            loadTerminalOutcome: vi.fn(async () => "accepted" as const),
            loadTurnTerminalOutcome: vi.fn(async () => "success" as const),
            createIntent: vi.fn(),
            advance: vi.fn(),
          },
          scheduleSessionCompletedPluginTasks,
        },
      },
    });

    await expect(
      slackRuntime.handleNewMention(
        thread,
        createTestMessage({
          id: "prior-terminal",
          text: "<@U0APP> already delivered",
          isMention: true,
          threadId: thread.id,
        }),
        { destination: createTestDestination(thread), ack },
      ),
    ).resolves.toBeUndefined();

    expect(run).not.toHaveBeenCalled();
    expect(scheduleSessionCompletedPluginTasks).toHaveBeenCalledWith({
      conversationId: thread.id,
      sessionId: "turn_prior-terminal",
    });
    expect(
      scheduleSessionCompletedPluginTasks.mock.invocationCallOrder[0],
    ).toBeLessThan(ack.mock.invocationCallOrder[0]!);
    expect(
      (await listAgentTurnSessionSummariesForConversation(thread.id)).find(
        (summary) => summary.sessionId === "turn_prior-terminal",
      )?.state,
    ).toBe("completed");
  });

  it.each(["missing", "lookup failure"] as const)(
    "defers a row-deleted accepted terminal when lifecycle classification has a %s",
    async (classificationFailure) => {
      const thread = createTestThread({
        id: `slack:C0FINAL:terminal-classification-${classificationFailure.replace(" ", "-")}`,
      });
      const ack = vi.fn();
      const run = vi.fn();
      const scheduleSessionCompletedPluginTasks = vi.fn();
      const loadTurnTerminalOutcome = vi.fn(async () => {
        if (classificationFailure === "lookup failure") {
          throw new Error("lifecycle lookup unavailable");
        }
        return undefined;
      });
      const messageId = `prior-terminal-${classificationFailure.replace(" ", "-")}`;
      const { slackRuntime } = createTestChatRuntime({
        services: {
          replyExecutor: {
            agentRunner: { run },
            recoverableSlackDelivery: {
              loadOldestByConversation: vi.fn(async () => undefined),
              loadByTurn: vi.fn(async () => undefined),
              loadTerminalOutcome: vi.fn(async () => "accepted" as const),
              loadTurnTerminalOutcome,
              createIntent: vi.fn(),
              advance: vi.fn(),
            },
            scheduleSessionCompletedPluginTasks,
          },
        },
      });

      await expect(
        slackRuntime.handleNewMention(
          thread,
          createTestMessage({
            id: messageId,
            text: "<@U0APP> already delivered",
            isMention: true,
            threadId: thread.id,
          }),
          {
            destination: createTestDestination(thread),
            ack,
          },
        ),
      ).rejects.toBeInstanceOf(TurnInputDeferredError);

      expect(loadTurnTerminalOutcome).toHaveBeenCalledOnce();
      expect(run).not.toHaveBeenCalled();
      expect(ack).not.toHaveBeenCalled();
      expect(scheduleSessionCompletedPluginTasks).not.toHaveBeenCalled();
      expect(thread.posts).toEqual([]);
      expect(
        (
          await listBoundedAgentTurnSessionSummariesForConversation(thread.id)
        ).find((summary) => summary.sessionId === `turn_${messageId}`),
      ).toBeUndefined();
    },
  );

  it("repairs a failed summary after an immediate definitive rejection", async () => {
    const ack = vi.fn();
    const recoverableSlackDelivery = {
      loadOldestByConversation: vi.fn(async () => undefined),
      loadByTurn: vi.fn(async () => undefined),
      loadTerminalOutcome: vi.fn(async () => undefined),
      loadTurnTerminalOutcome: vi.fn(async () => undefined),
      createIntent: vi.fn(
        async (args) =>
          ({
            ...args,
            nextAttemptAtMs: Date.now(),
            command: args.command,
          }) as never,
      ),
      advance: vi.fn(async () => ({ outcome: "failed" as const })),
    };
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async () =>
              completedAgentRun({
                text: "Slack will reject this",
                diagnostics: makeDiagnostics(),
              }),
          },
          recoverableSlackDelivery,
        },
      },
    });
    const thread = createTestThread({
      id: "slack:C0FINAL:1700006014.000",
    });
    (thread.adapter as { name?: string }).name = "slack";

    await expect(
      slackRuntime.handleNewMention(
        thread,
        createTestMessage({
          id: "definitive-failure",
          text: "<@U0APP> reply",
          isMention: true,
          threadId: thread.id,
        }),
        { destination: createTestDestination(thread), ack },
      ),
    ).resolves.toBeUndefined();

    expect(ack).toHaveBeenCalledOnce();
    expect(thread.posts).toEqual([]);
    expect(
      (await listAgentTurnSessionSummariesForConversation(thread.id)).find(
        (summary) => summary.sessionId === "turn_definitive-failure",
      )?.state,
    ).toBe("failed");
  });

  it("does not let plugin repair failure override accepted delivery", async () => {
    const ack = vi.fn();
    const scheduleSessionCompletedPluginTasks = vi.fn(async () => {
      throw new Error("plugin queue unavailable");
    });
    const recoverableSlackDelivery = {
      loadOldestByConversation: vi.fn(async () => undefined),
      loadByTurn: vi.fn(async () => undefined),
      loadTerminalOutcome: vi.fn(async () => undefined),
      loadTurnTerminalOutcome: vi.fn(async () => undefined),
      createIntent: vi.fn(
        async (args) =>
          ({
            ...args,
            nextAttemptAtMs: Date.now(),
            command: args.command,
          }) as never,
      ),
      advance: vi.fn(async () => ({ outcome: "accepted" as const })),
    };
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async () =>
              completedAgentRun({
                text: "Accepted reply",
                diagnostics: makeDiagnostics(),
              }),
          },
          recoverableSlackDelivery,
          scheduleSessionCompletedPluginTasks,
        },
      },
    });
    const thread = createTestThread({
      id: "slack:C0FINAL:1700006015.000",
    });
    (thread.adapter as { name?: string }).name = "slack";

    await expect(
      slackRuntime.handleNewMention(
        thread,
        createTestMessage({
          id: "plugin-repair-failure",
          text: "<@U0APP> reply",
          isMention: true,
          threadId: thread.id,
        }),
        { destination: createTestDestination(thread), ack },
      ),
    ).resolves.toBeUndefined();

    expect(scheduleSessionCompletedPluginTasks).toHaveBeenCalledOnce();
    expect(ack).toHaveBeenCalledOnce();
    expect(thread.posts).toEqual([]);
    expect(
      (await listAgentTurnSessionSummariesForConversation(thread.id)).find(
        (summary) => summary.sessionId === "turn_plugin-repair-failure",
      )?.state,
    ).toBe("completed");
  });

  it("defers callback failure after durable intent without failing the turn", async () => {
    const lifecycle = {
      start: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    let intent: unknown;
    const recoverableSlackDelivery = {
      loadOldestByConversation: vi.fn(async () => undefined),
      loadByTurn: vi.fn(async () => intent as never),
      loadTerminalOutcome: vi.fn(async () => undefined),
      loadTurnTerminalOutcome: vi.fn(async () => undefined),
      createIntent: vi.fn(async (args) => {
        intent = {
          ...args,
          nextAttemptAtMs: Date.now(),
          command: args.command,
        };
        return intent as never;
      }),
      advance: vi.fn(),
    };
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async () =>
              completedAgentRun({
                text: "reply",
                diagnostics: makeDiagnostics(),
              }),
          },
          recoverableSlackDelivery,
          turnLifecycle: lifecycle,
        },
      },
    });
    const thread = createTestThread({
      id: "slack:C0FINAL:1700006010.000",
    });
    (thread as unknown as { adapter: { name: string } }).adapter = {
      name: "slack",
    };

    await expect(
      slackRuntime.handleNewMention(
        thread,
        createTestMessage({
          id: "intent-callback-failure",
          text: "<@U0APP> reply",
          isMention: true,
          threadId: thread.id,
        }),
        {
          destination: createTestDestination(thread),
          isFinalAttempt: false,
          beforeFirstResponsePost: async () => {
            throw new Error("status cleanup failed");
          },
        },
      ),
    ).rejects.toBeInstanceOf(TurnInputDeferredError);

    expect(recoverableSlackDelivery.createIntent).toHaveBeenCalledOnce();
    expect(recoverableSlackDelivery.advance).not.toHaveBeenCalled();
    expect(lifecycle.fail).not.toHaveBeenCalled();
    expect(thread.posts).toEqual([]);
  });

  it("acknowledges canvas recovery after a terminal run failure", async () => {
    const ack = vi.fn();
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async (request) => {
              await request.durability?.onArtifactStateUpdated?.({
                lastCanvasId: "F_CANVAS_RECOVERY",
                lastCanvasUrl: "https://slack.example/docs/T/F_CANVAS_RECOVERY",
              });
              throw new Error("run interrupted after canvas creation");
            },
          },
        },
      },
    });
    const thread = createTestThread({
      id: "slack:C0FINAL:1700006011.000",
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "canvas-recovery",
        text: "<@U0APP> create a canvas",
        isMention: true,
        threadId: thread.id,
      }),
      { destination: createTestDestination(thread), ack },
    );

    expect(ack).toHaveBeenCalledOnce();
    expect(thread.posts.map(toPostedText).join("\n")).toContain(
      "https://slack.example/docs/T/F_CANVAS_RECOVERY",
    );
  });
});
