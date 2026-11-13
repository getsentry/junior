import { createHmac } from "node:crypto";
import type {
  CodeChangeInput,
  ConversationAnnotationInput,
  EventInput,
  EventPublisher,
  HeartbeatHookContext,
  PluginReviewNotice,
  PluginState,
} from "@sentry/junior-plugin-api";
import { expect } from "vitest";
import { githubPlugin } from "../src/index";
import type { GitHubFixture } from "./github-db";

/** A signed GitHub webhook delivery. */
export function signedRequest(input: {
  body: unknown;
  deliveryId: string;
  eventName: string;
}): Request {
  const body = JSON.stringify(input.body);
  return new Request("https://example.test/api/webhooks/github", {
    method: "POST",
    headers: {
      "x-github-delivery": input.deliveryId,
      "x-github-event": input.eventName,
      "x-hub-signature-256": `sha256=${createHmac("sha256", "test-secret")
        .update(body)
        .digest("hex")}`,
    },
    body,
  });
}

/** Plugin state in memory, with expiry. */
function memoryState(): PluginState {
  const stored = new Map<string, { expiresAtMs: number; value: unknown }>();
  const live = (key: string) => {
    const entry = stored.get(key);
    if (entry && entry.expiresAtMs <= Date.now()) stored.delete(key);
    return stored.get(key);
  };
  const store = (key: string, value: unknown, ttlMs?: number) => {
    stored.set(key, {
      expiresAtMs: ttlMs ? Date.now() + ttlMs : Infinity,
      value: structuredClone(value),
    });
  };
  return {
    async delete(key) {
      stored.delete(key);
    },
    async get<T>(key: string) {
      return live(key)?.value as T | undefined;
    },
    async set(key, value, ttlMs) {
      store(key, value, ttlMs);
    },
    async setIfNotExists(key, value, ttlMs) {
      if (live(key)) return false;
      store(key, value, ttlMs);
      return true;
    },
    async withLock(_key, _ttlMs, callback) {
      return await callback();
    },
  };
}

/**
 * The GitHub plugin's webhook route and heartbeat with real wiring, and fake
 * Junior services that record what the plugin sends them. The Watch made
 * after Junior creates pull request getsentry/junior#946 matches events.
 */
export function createPluginHarness(fixture: GitHubFixture) {
  const recorded = {
    annotations: [] as Array<{
      annotation: ConversationAnnotationInput;
      conversationId: string;
    }>,
    closedNotices: [] as string[],
    codeChanges: [] as CodeChangeInput[],
    heartbeatLogs: [] as Array<[level: string, message: string]>,
    notices: [] as Array<{
      conversationId: string;
      notice: PluginReviewNotice;
    }>,
    published: [] as EventInput[],
  };
  const watches = { comments: true, conflicts: true };
  /** Review desk calls that fail before one succeeds. */
  const failures = { upsert: 0 };
  const state = memoryState();
  const events: EventPublisher = {
    async hasMatch(candidates) {
      return candidates.some(
        (event) =>
          event.identifier === "getsentry/junior#946" &&
          (event.eventType === "pull_request.merge_conflict"
            ? watches.conflicts
            : watches.comments),
      );
    },
    async publish(event) {
      recorded.published.push(event);
    },
  };
  const reviewItems: HeartbeatHookContext["reviewItems"] = {
    forConversation(conversationId) {
      return {
        async upsert(notice) {
          if (failures.upsert > 0) {
            failures.upsert -= 1;
            throw new Error("The review desk is down");
          }
          recorded.notices.push({ conversationId, notice });
        },
        async close(input) {
          recorded.closedNotices.push(input.dedupeKey);
        },
      };
    },
  };
  const cache: HeartbeatHookContext["cache"] = {
    async getOrLoad(_key, load) {
      return (await load()).value;
    },
  };

  async function deliver(request: Request): Promise<void> {
    const [route] = githubPlugin().hooks!.routes!({
      annotations: {
        forConversation() {
          return {
            async upsert() {},
            async remove() {},
            async list() {
              return [];
            },
          };
        },
      },
      cache,
      codeChanges: {
        async associateConversations() {},
        async recordActivity() {},
        async record() {},
      },
      db: fixture.db(),
      events,
      log: { error() {}, info() {}, warn() {} },
      plugin: { name: "github" },
      reviewItems,
      state,
      users: {
        async readIdentity() {
          return undefined;
        },
      },
    });
    const response = await route!.handler(request);
    expect(response.status).toBe(202);
  }

  async function heartbeat(nowMs: number): Promise<void> {
    const unused = () => {
      throw new Error("The GitHub heartbeat does not use this");
    };
    await githubPlugin().hooks!.heartbeat!({
      agent: { dispatch: unused, get: unused },
      annotations: {
        forConversation(conversationId) {
          return {
            async upsert(annotation) {
              recorded.annotations.push({ annotation, conversationId });
            },
            async remove() {},
            async list() {
              return [];
            },
          };
        },
      },
      cache,
      codeChanges: {
        async associateConversations() {},
        async recordActivity() {},
        async record(input) {
          recorded.codeChanges.push(input);
        },
      },
      db: fixture.db(),
      embedder: { embedTexts: unused, model: "unused", provider: "unused" },
      events,
      log: {
        error: (message) => recorded.heartbeatLogs.push(["error", message]),
        info() {},
        warn: (message) => recorded.heartbeatLogs.push(["warn", message]),
      },
      nowMs,
      plugin: { name: "github" },
      reviewItems,
      state,
    });
  }

  return { ...recorded, deliver, events, failures, heartbeat, watches };
}

export type PluginHarness = ReturnType<typeof createPluginHarness>;
