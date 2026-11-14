import {
  defineJuniorPlugin,
  definePluginTool,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai/compat";
import type { CacheWarmupMessage } from "@/chat/cache-warming/queue";
import { createApp } from "@/app";
import { defineJuniorPlugins } from "@/plugins";
import { resolveGatewayModel } from "@/chat/pi/client";
import type { PromptMode } from "@/chat/system-prompt-rules";
import { getStateAdapter } from "@/chat/state/adapter";
import { mockTitleModel } from "../../fixtures/title-model";

const mocks = vi.hoisted(() => ({
  sendCacheWarmup: vi.fn(async (_message: unknown, _delayMs: number) => {}),
}));

vi.mock("@/chat/cache-warming/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/cache-warming/queue")>()),
  sendCacheWarmup: mocks.sendCacheWarmup,
}));

const { createCacheWarmingRecorder, runCacheWarmup } =
  await import("@/chat/cache-warming/warmup");

const MINUTE = 60_000;
const conversationId = "local:test:cache-warming-definitions";
const newConversationId = "local:test:cache-warming-definitions-new";
const oldConversationId = "local:test:cache-warming-definitions-old";
const model = resolveGatewayModel("anthropic/claude-opus-5.5");
const context: Context = {
  systemPrompt: "Answer the person.",
  messages: [{ role: "user", content: "Hi.", timestamp: 1 }],
};
const finalReply: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "Done." }],
  api: "anthropic-messages",
  provider: "vercel-ai-gateway",
  model: model.id,
  usage: {
    input: 10,
    output: 10,
    cacheRead: 60_000,
    cacheWrite: 0,
    totalTokens: 60_020,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 1,
};

const definitionsKey = { platform: "local", mode: "conversation" } as const;

// A test plugin with one static tool, whose description a deploy can change.
function lookupPlugin(description: string) {
  return defineJuniorPlugin({
    manifest: {
      name: "lookup",
      displayName: "Lookup",
      description: "Cache warming fingerprint test plugin",
    },
    hooks: {
      tools: () => ({
        record: definePluginTool({
          annotations: {
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
            readOnlyHint: true,
          },
          description,
          inputSchema: z.object({}),
          outputSchema: pluginToolOutputSchema,
          execute: async () => ({}),
        }),
      }),
    },
  });
}

// A test plugin that only configures an MCP provider.
const trackerMcpPlugin = defineJuniorPlugin({
  manifest: {
    name: "tracker",
    displayName: "Tracker",
    description: "Issue tracking for project work",
    mcp: { transport: "http", url: "https://mcp.tracker.example/mcp" },
  },
});

// Start the app as one deployment with these plugins.
async function deploy(
  deploymentId: string,
  plugins: ReturnType<typeof defineJuniorPlugin>[],
) {
  vi.stubEnv("VERCEL_DEPLOYMENT_ID", deploymentId);
  await createApp({
    dashboard: { disabled: true },
    plugins: defineJuniorPlugins(plugins),
  });
}

// Run one Turn that ends with a final response, like one agent run does.
async function endTurn(
  userActor: boolean,
  id = conversationId,
  turnContext = context,
  mode: PromptMode = definitionsKey.mode,
) {
  const recorder = createCacheWarmingRecorder(id, userActor, {
    ...definitionsKey,
    mode,
  });
  recorder.wrap((() => undefined) as never)(model, turnContext, {});
  await recorder.record(finalReply);
}

type WarmupMessage = Extract<CacheWarmupMessage, { kind: "warmup" }>;

function scheduledWarmup(): WarmupMessage {
  const message = mocks.sendCacheWarmup.mock.calls
    .map(([sent]) => sent as CacheWarmupMessage)
    .reverse()
    .find((sent): sent is WarmupMessage => sent.kind === "warmup");
  if (!message) throw new Error("No warmup was scheduled.");
  return message;
}

describe("cache warming definitions", () => {
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const id of [conversationId, newConversationId, oldConversationId]) {
      await getStateAdapter().delete(`junior:cache_warming:conversation:${id}`);
    }
    for (const key of [
      "defs:first_seen:dpl_old",
      "defs:first_seen:dpl_new",
      "defs:fingerprint:local:conversation",
    ]) {
      await getStateAdapter().delete(`junior:cache_warming:${key}`);
    }
  });

  // A deploy: `dpl_old` ends a Turn, then `dpl_new`, with `newPlugins`, ends
  // one in another Conversation. Then a late Turn of `dpl_old` starts an idle
  // period, and its warmup runs on `dpl_old`. Nobody comes back.
  async function warmOldIdlePeriod(
    newPlugins: ReturnType<typeof defineJuniorPlugin>[],
  ) {
    const state = getStateAdapter();
    for (let i = 0; i < 20; i++) {
      await state.appendToList(
        "junior:cache_warming:gaps:user:1:none",
        8 * MINUTE,
      );
    }
    const oldPlugins = [lookupPlugin("Look up a record.")];
    vi.useFakeTimers({ toFake: ["Date"] });
    mocks.sendCacheWarmup.mockClear();
    try {
      const warmupRequests: unknown[] = [];
      mockTitleModel("", {
        onRequest: (request) => warmupRequests.push(request),
      });
      await deploy("dpl_old", oldPlugins);
      await endTurn(true, oldConversationId);
      vi.advanceTimersByTime(MINUTE);
      await deploy("dpl_new", newPlugins);
      await endTurn(true, newConversationId);
      vi.advanceTimersByTime(MINUTE);
      await deploy("dpl_old", oldPlugins);
      await endTurn(true, conversationId);
      const warmup = scheduledWarmup();
      await runCacheWarmup(warmup);
      const snapshot = await state.get(
        `junior:cache_warming:snapshot:${conversationId}:${warmup.generation}`,
      );
      return { warmupRequests, snapshot };
    } finally {
      vi.unstubAllEnvs();
      await state.delete("junior:cache_warming:gaps:user:1:none");
      await state.delete("junior:cache_warming:breaker:anthropic:outcomes");
    }
  }

  it.each([
    {
      name: "a static tool definition",
      newPlugins: [lookupPlugin("Look up a record, then cite it.")],
    },
    {
      name: "the configured MCP providers",
      newPlugins: [lookupPlugin("Look up a record."), trackerMcpPlugin],
    },
  ])(
    "stops an old deployment's idle period at once when a newer deployment changed $name",
    async ({ newPlugins }) => {
      const { warmupRequests, snapshot } = await warmOldIdlePeriod(newPlugins);

      expect(warmupRequests).toEqual([]);
      expect(snapshot).toBeNull();
    },
  );

  it("keeps warming an old deployment's idle period when a newer deployment has the same fingerprint", async () => {
    const { warmupRequests } = await warmOldIdlePeriod([
      lookupPlugin("Look up a record."),
    ]);

    expect(warmupRequests).toHaveLength(1);
  });

  it("keeps warming the newer deployment's idle period after both deployments run for longer than the record TTL", async () => {
    const state = getStateAdapter();
    for (let i = 0; i < 20; i++) {
      await state.appendToList(
        "junior:cache_warming:gaps:user:1:none",
        8 * MINUTE,
      );
    }
    const oldPlugins = [lookupPlugin("Look up a record.")];
    const newPlugins = [lookupPlugin("Look up a record, then cite it.")];
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const warmupRequests: unknown[] = [];
      mockTitleModel("", {
        onRequest: (request) => warmupRequests.push(request),
      });
      // Both deployments start an idle period every day for a week: the
      // TTL of the records that each one wrote on its first day.
      for (let day = 0; day < 7; day++) {
        await deploy("dpl_old", oldPlugins);
        await endTurn(true, oldConversationId);
        vi.advanceTimersByTime(60 * MINUTE);
        await deploy("dpl_new", newPlugins);
        await endTurn(true, newConversationId);
        vi.advanceTimersByTime(23 * 60 * MINUTE);
      }
      await deploy("dpl_new", newPlugins);
      mocks.sendCacheWarmup.mockClear();
      await endTurn(true, conversationId);
      const warmup = scheduledWarmup();
      // A late Turn of `dpl_old` starts an idle period.
      vi.advanceTimersByTime(MINUTE);
      await deploy("dpl_old", oldPlugins);
      await endTurn(true, oldConversationId);
      await deploy("dpl_new", newPlugins);
      await runCacheWarmup(warmup);

      expect(warmupRequests).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
      await state.delete("junior:cache_warming:gaps:user:1:none");
      await state.delete("junior:cache_warming:breaker:anthropic:outcomes");
    }
  });
});
