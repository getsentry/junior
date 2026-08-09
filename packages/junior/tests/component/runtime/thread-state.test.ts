import type { Thread } from "chat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as dbModule from "@/chat/db";
import {
  getChannelConfigurationService,
  getPersistedSandboxState,
  getPersistedThreadState,
  persistThreadRuntimeState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import { loadChannelConfiguration } from "@/chat/configuration/store";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { JUNIOR_THREAD_STATE_TTL_MS } from "@/chat/state/ttl";
import {
  createLocalJuniorSqlFixture,
  type LocalJuniorSqlFixture,
} from "../../fixtures/sql";

const originalStateAdapter = process.env.JUNIOR_STATE_ADAPTER;

describe("thread sandbox state", () => {
  let fixture: LocalJuniorSqlFixture | undefined;

  beforeEach(async () => {
    process.env.JUNIOR_STATE_ADAPTER = "memory";
    await disconnectStateAdapter();
    await dbModule.closeDb();
    fixture = await createLocalJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    vi.spyOn(dbModule, "getSqlExecutor").mockReturnValue(fixture.sql);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await disconnectStateAdapter();
    await dbModule.closeDb();
    await fixture?.close();
    fixture = undefined;
    if (originalStateAdapter === undefined) {
      delete process.env.JUNIOR_STATE_ADAPTER;
    } else {
      process.env.JUNIOR_STATE_ADAPTER = originalStateAdapter;
    }
  });

  it("clears a stale profile hash when the replacement reference omits one", async () => {
    const conversationId = "local:test:thread-sandbox-state";
    await persistThreadStateById(conversationId, {
      sandboxRef: { id: "sandbox-old", profileHash: "profile-old" },
    });

    await persistThreadStateById(conversationId, {
      sandboxRef: { id: "sandbox-new" },
    });

    const state = await getPersistedThreadState(conversationId);
    expect(state).toMatchObject({
      app_sandbox_id: "sandbox-new",
      app_sandbox_dependency_profile_hash: "",
    });
    expect(getPersistedSandboxState(state)).toEqual({ id: "sandbox-new" });
  });

  it("clears both fields when the sandbox reference is removed", async () => {
    const conversationId = "local:test:thread-sandbox-clear";
    await persistThreadStateById(conversationId, {
      sandboxRef: { id: "sandbox-old", profileHash: "profile-old" },
    });

    await persistThreadStateById(conversationId, { sandboxRef: null });

    const state = await getPersistedThreadState(conversationId);
    expect(state).toMatchObject({
      app_sandbox_id: "",
      app_sandbox_dependency_profile_hash: "",
    });
    expect(getPersistedSandboxState(state)).toBeUndefined();
  });

  it("writes thread scratch with Junior's 7-day TTL and channel config to SQL", async () => {
    const stateAdapter = getStateAdapter();
    const set = vi.spyOn(stateAdapter, "set");
    const conversationId = "local:test:thread-scratch-ttl";
    const channelId = "C-scratch-ttl";

    await persistThreadStateById(conversationId, {
      sandboxRef: { id: "sandbox-ttl" },
    });
    expect(set).toHaveBeenCalledWith(
      `thread-state:${conversationId}`,
      expect.objectContaining({ app_sandbox_id: "sandbox-ttl" }),
      JUNIOR_THREAD_STATE_TTL_MS,
    );

    set.mockClear();
    const thread = {
      id: conversationId,
      channelId,
      channel: { id: channelId },
    } as Thread;
    await persistThreadRuntimeState(thread, {
      artifacts: { lastCanvasId: "Fcanvas" },
    });
    expect(set).toHaveBeenCalledWith(
      `thread-state:${conversationId}`,
      expect.objectContaining({
        app_sandbox_id: "sandbox-ttl",
        artifacts: expect.objectContaining({ lastCanvasId: "Fcanvas" }),
      }),
      JUNIOR_THREAD_STATE_TTL_MS,
    );

    set.mockClear();
    await getChannelConfigurationService(thread).set({
      key: "github.repo",
      value: "getsentry/junior",
      updatedBy: "U123",
    });
    expect(set).not.toHaveBeenCalledWith(
      `channel-state:${channelId}`,
      expect.anything(),
      expect.anything(),
    );
    await expect(loadChannelConfiguration(channelId)).resolves.toMatchObject({
      entries: {
        "github.repo": {
          key: "github.repo",
          value: "getsentry/junior",
          updatedBy: "U123",
        },
      },
    });
  });

  it("adopts legacy Redis channel configuration into SQL once", async () => {
    const channelId = "C-legacy-config";
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    await stateAdapter.set(
      `channel-state:${channelId}`,
      {
        configuration: {
          schemaVersion: 1,
          entries: {
            "github.repo": {
              key: "github.repo",
              value: "getsentry/legacy",
              scope: "conversation",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          },
        },
      },
      JUNIOR_THREAD_STATE_TTL_MS,
    );

    const service = getChannelConfigurationService({
      channelId,
      channel: { id: channelId },
    } as Thread);
    await expect(service.resolve("github.repo")).resolves.toBe(
      "getsentry/legacy",
    );
    await expect(loadChannelConfiguration(channelId)).resolves.toMatchObject({
      entries: {
        "github.repo": {
          value: "getsentry/legacy",
        },
      },
    });
    await expect(
      stateAdapter.get(`channel-state:${channelId}`),
    ).resolves.toBeFalsy();
  });
});
