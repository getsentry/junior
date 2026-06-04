import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defineJuniorPlugin,
  type PluginDb,
} from "@sentry/junior-plugin-api";
import { createHeartbeatContext } from "@/chat/agent-dispatch/context";
import {
  getDispatchRecord,
  listIncompleteDispatchIds,
} from "@/chat/agent-dispatch/store";
import * as pluginDbModule from "@/chat/plugins/db";
import {
  createCredentialSubject,
  mockDispatchCallbackFetch,
  resetHeartbeatTestEnv,
  setupHeartbeatTestEnv,
} from "../fixtures/heartbeat";
import { getCapturedSlackApiCalls } from "../msw/handlers/slack-api";

vi.hoisted(() => {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
});

describe("trusted plugin heartbeat context", () => {
  const originalFetch = global.fetch;

  beforeEach(async () => {
    await setupHeartbeatTestEnv();
  });

  afterEach(async () => {
    await resetHeartbeatTestEnv(originalFetch);
  });

  it("scopes dispatch lookup to the plugin that created it", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("Accepted", { status: 202 });
    });
    global.fetch = fetchMock as typeof fetch;

    const schedulerCtx = createHeartbeatContext({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
    });
    const result = await schedulerCtx.agent.dispatch({
      idempotencyKey: "run-1",
      destination: {
        platform: "slack",
        teamId: "T123",
        channelId: "C123",
      },
      input: "Run the scheduled task.",
      metadata: { runId: "run-1" },
    });

    await expect(schedulerCtx.agent.get(result.id)).resolves.toEqual({
      id: result.id,
      status: "pending",
    });
    await expect(
      createHeartbeatContext({
        plugin: "other-plugin",
        nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
      }).agent.get(result.id),
    ).resolves.toBeUndefined();

    await expect(getDispatchRecord(result.id)).resolves.toMatchObject({
      input: "Run the scheduled task.",
      destination: { channelId: "C123" },
      metadata: { runId: "run-1" },
    });
  });

  it("exposes plugin DB access to heartbeat contexts for database plugins", () => {
    const db = {} as PluginDb;
    const spy = vi
      .spyOn(pluginDbModule, "getPluginDbForRegistration")
      .mockReturnValue(db);
    const plugin = defineJuniorPlugin({
      database: {},
      manifest: {
        name: "database-plugin",
        displayName: "Database Plugin",
        description: "Heartbeat database context test",
      },
    });

    const ctx = createHeartbeatContext({
      plugin,
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
    });

    expect(spy).toHaveBeenCalledWith(plugin);
    expect(ctx.db).toBe(db);
  });

  it("keeps plugin state isolated when plugin names and keys contain delimiters", async () => {
    const first = createHeartbeatContext({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
    });
    const second = createHeartbeatContext({
      plugin: "scheduler:run",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
    });

    await first.state.set("run:1", "first");
    await second.state.set("1", "second");

    await expect(first.state.get("run:1")).resolves.toBe("first");
    await expect(second.state.get("1")).resolves.toBe("second");
  });

  it("bounds dispatch fanout from one heartbeat context", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("Accepted", { status: 202 });
    });
    global.fetch = fetchMock as typeof fetch;

    const ctx = createHeartbeatContext({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
    });

    for (let index = 0; index < 25; index += 1) {
      await ctx.agent.dispatch({
        idempotencyKey: `run-${index}`,
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "C123",
        },
        input: "Run the scheduled task.",
      });
    }

    await expect(
      ctx.agent.dispatch({
        idempotencyKey: "run-over-limit",
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "C123",
        },
        input: "Run the scheduled task.",
      }),
    ).rejects.toThrow("Plugin heartbeat exceeded the dispatch limit");
  });

  it("does not count invalid dispatch requests against heartbeat fanout", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("Accepted", { status: 202 });
    });
    global.fetch = fetchMock as typeof fetch;

    const ctx = createHeartbeatContext({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
    });

    for (let index = 0; index < 25; index += 1) {
      await expect(
        ctx.agent.dispatch({
          idempotencyKey: `invalid-${index}`,
          destination: {
            platform: "slack",
            teamId: "not-a-team",
            channelId: "C123",
          },
          input: "Run the scheduled task.",
        }),
      ).rejects.toThrow("Dispatch destination teamId must be a Slack team id");
    }

    await expect(
      ctx.agent.dispatch({
        idempotencyKey: "valid-after-invalid",
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "C123",
        },
        input: "Run the scheduled task.",
      }),
    ).resolves.toMatchObject({ status: "created" });
  });

  it("rejects plugin credential subjects that include runtime bindings", async () => {
    mockDispatchCallbackFetch(originalFetch);

    const ctx = createHeartbeatContext({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
    });

    await expect(
      ctx.agent.dispatch({
        idempotencyKey: "run-delegated-mismatch",
        credentialSubject: {
          ...createCredentialSubject(),
          binding: {
            type: "slack-direct-conversation",
            teamId: "T123",
            channelId: "D999",
            signature: "v1=test",
          },
        } as any,
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "D123",
        },
        input: "Run the scheduled task.",
      }),
    ).rejects.toThrow("Dispatch credentialSubject binding is runtime-owned");
    expect(getCapturedSlackApiCalls("conversations.info")).toHaveLength(0);
    await expect(listIncompleteDispatchIds()).resolves.toEqual([]);
  });

  it("binds delegated credential subjects before persistence", async () => {
    mockDispatchCallbackFetch(originalFetch);
    const ctx = createHeartbeatContext({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
    });

    const result = await ctx.agent.dispatch({
      idempotencyKey: "run-delegated",
      credentialSubject: createCredentialSubject(),
      destination: {
        platform: "slack",
        teamId: "T123",
        channelId: "D123",
      },
      input: "Run the scheduled task.",
    });

    await expect(getDispatchRecord(result.id)).resolves.toMatchObject({
      credentialSubject: {
        type: "user",
        userId: "U123",
        allowedWhen: "private-direct-conversation",
        binding: {
          type: "slack-direct-conversation",
          teamId: "T123",
          channelId: "D123",
          signature: expect.any(String),
        },
      },
    });
    expect(getCapturedSlackApiCalls("conversations.info")).toHaveLength(0);
  });
});
