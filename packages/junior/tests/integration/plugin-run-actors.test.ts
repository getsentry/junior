import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createLocalSource, type Destination } from "@sentry/junior-plugin-api";

/**
 * Proves the `run.actors` runtime threading contract from
 * `specs/multi-actor-runs.md`: the live actors getter passed into the plugin
 * hook runner is seeded from the run actor and grows as steering messages
 * with a resolvable actor drain into the run, without ever including an
 * unattributable steering message.
 */

const originalStateAdapter = process.env.JUNIOR_STATE_ADAPTER;
process.env.JUNIOR_STATE_ADAPTER = "memory";

const { captured } = vi.hoisted(() => ({
  captured: {
    actorsGetter: undefined as (() => unknown[]) | undefined,
    runActor: undefined as unknown,
  },
}));

vi.mock("@earendil-works/pi-agent-core", () => {
  class MockAgent {
    state: {
      messages: unknown[];
      model: unknown;
      systemPrompt: string;
      tools: unknown[];
    };
    private prepareNextTurn?: () => Promise<unknown> | unknown;

    constructor(input: {
      prepareNextTurn?: () => Promise<unknown> | unknown;
      initialState: {
        model: unknown;
        systemPrompt: string;
        tools: unknown[];
      };
    }) {
      this.state = {
        messages: [],
        model: input.initialState.model,
        systemPrompt: input.initialState.systemPrompt,
        tools: input.initialState.tools,
      };
      this.prepareNextTurn = input.prepareNextTurn;
    }

    subscribe() {
      return () => undefined;
    }

    abort() {}

    async continue() {
      this.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "Continued." }],
        stopReason: "stop",
      });
      return {};
    }

    async prompt(message: unknown) {
      this.state.messages.push(message);
      await this.prepareNextTurn?.();
      this.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        stopReason: "stop",
      });
      return {};
    }

    steer(message: unknown) {
      this.state.messages.push(message);
    }
  }

  return { Agent: MockAgent };
});

vi.mock("@/chat/pi/client", () => ({
  GEN_AI_PROVIDER_NAME: "vercel-ai-gateway",
  GEN_AI_SERVER_ADDRESS: "ai-gateway.vercel.sh",
  GEN_AI_SERVER_PORT: 443,
  completeObject: async () => ({
    object: {
      thinking_level: "medium",
      confidence: 1,
      reason: "test-router",
    },
  }),
  getPiGatewayApiKey: () => "test-gateway-key",
  resolveGatewayModel: (modelId: string) => modelId,
}));

vi.mock("@/chat/plugins/agent-hooks", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/chat/plugins/agent-hooks")>();
  return {
    ...actual,
    createPluginHookRunner: (
      input: Parameters<typeof actual.createPluginHookRunner>[0] = {},
    ) => {
      captured.actorsGetter = input.actors as (() => unknown[]) | undefined;
      captured.runActor = input.actor;
      return actual.createPluginHookRunner(input);
    },
  };
});

import { executeAgentRun } from "@/chat/agent";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { upsertAgentTurnSessionRecord } from "@/chat/state/turn-session";

const LOCAL_DESTINATION = {
  platform: "local",
  conversationId: "local:test:plugin-run-actors",
} satisfies Destination;
const LOCAL_SOURCE = createLocalSource(LOCAL_DESTINATION.conversationId);

const RUN_ACTOR = {
  platform: "local",
  userId: "local-run-actor",
  fullName: "Run Actor",
} as const;

const STEERING_ACTOR = {
  platform: "local",
  userId: "local-steering-actor",
  fullName: "Steering Actor",
} as const;

const BATCHED_ACTOR = {
  platform: "local",
  userId: "local-batched-actor",
  fullName: "Batched Actor",
} as const;

describe("run actors threading", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
  });

  afterAll(() => {
    if (originalStateAdapter === undefined) {
      delete process.env.JUNIOR_STATE_ADAPTER;
    } else {
      process.env.JUNIOR_STATE_ADAPTER = originalStateAdapter;
    }
  });

  it("seeds the live actors getter with the run actor and grows it as steering drains", async () => {
    await executeAgentRun({
      input: { messageText: "hello" },
      routing: {
        destination: LOCAL_DESTINATION,
        source: LOCAL_SOURCE,
        actor: RUN_ACTOR,
        correlation: {
          conversationId: "conversation-run-actors",
          turnId: "turn-run-actors",
        },
      },
      durability: {
        drainSteeringMessages: async (inject) => {
          await inject([
            {
              text: "steer me",
              provenance: { authority: "instruction", actor: STEERING_ACTOR },
            },
          ]);
          return [];
        },
      },
    });

    expect(captured.runActor).toEqual(RUN_ACTOR);
    expect(captured.actorsGetter?.()).toEqual([RUN_ACTOR, STEERING_ACTOR]);
  });

  it("seeds the live actors getter from a fresh run's committed prefix", async () => {
    const conversationId = "conversation-run-actors-batched";
    const sessionId = "turn-run-actors-batched";

    await upsertAgentTurnSessionRecord({
      actor: RUN_ACTOR,
      conversationId,
      sessionId,
      sliceId: 1,
      state: "running",
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "batched ask" }],
          timestamp: 1,
        },
      ],
      trailingMessageProvenance: [
        { authority: "instruction", actor: BATCHED_ACTOR },
      ],
    });

    await executeAgentRun({
      input: { messageText: "hello" },
      routing: {
        destination: LOCAL_DESTINATION,
        source: LOCAL_SOURCE,
        actor: RUN_ACTOR,
        correlation: {
          conversationId,
          turnId: sessionId,
        },
      },
    });

    expect(captured.runActor).toEqual(RUN_ACTOR);
    expect(captured.actorsGetter?.()).toEqual([BATCHED_ACTOR, RUN_ACTOR]);
  });

  it("does not credit an unresolvable steering actor", async () => {
    await executeAgentRun({
      input: { messageText: "hello" },
      routing: {
        destination: LOCAL_DESTINATION,
        source: LOCAL_SOURCE,
        actor: RUN_ACTOR,
        correlation: {
          conversationId: "conversation-run-actors-unresolved",
          turnId: "turn-run-actors-unresolved",
        },
      },
      durability: {
        drainSteeringMessages: async (inject) => {
          await inject([
            { text: "steer me", provenance: { authority: "instruction" } },
          ]);
          return [];
        },
      },
    });

    expect(captured.actorsGetter?.()).toEqual([RUN_ACTOR]);
  });
});
