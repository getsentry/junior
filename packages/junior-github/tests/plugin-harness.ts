import { createHmac } from "node:crypto";
import type {
  CodeChangeInput,
  ConversationAnnotationInput,
  ConversationChangeBatch,
  EventInput,
  EventPublisher,
  HeartbeatHookContext,
  PluginReviewNotice,
  PluginState,
} from "@sentry/junior-plugin-api";
import { expect } from "vitest";
import { githubPlugin } from "../src/index";
import { conversationChangesThrough } from "./conversation-changes";
import type { GitHubFixture } from "./github-db";

/** A signed GitHub webhook delivery. */

/** The key of a plugin item's subject in the harness: `<kind>:<id>`. */
export function subjectKey(subject: { id: string; kind: string }): string {
  return `${subject.kind}:${subject.id}`;
}

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
export function memoryState(): PluginState {
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
      return { acquired: true, value: await callback() };
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
    /** Batches of annotation and Inbox item changes, in order. */
    batches: [] as ConversationChangeBatch[],
    closedNotices: [] as string[],
    codeChanges: [] as CodeChangeInput[],
    heartbeatLogs: [] as Array<[level: string, message: string]>,
    /** Inbox items added. A change to an open item adds none. */
    notices: [] as Array<{
      conversationId: string;
      notice: PluginReviewNotice;
    }>,
    published: [] as EventInput[],
    /** Watches that the plugin made, with the events published before. */
    subscribed: [] as Array<{
      events: string[];
      identifier: string;
      publishedBefore: number;
    }>,
  };
  /**
   * Whether any Watch gets comments and conflicts on 946, and whether the
   * Conversation that asked for 946 has its own conflict Watch.
   */
  const watches = { comments: true, conflicts: true, ownConflicts: true };
  /** Inbox and publish calls that fail before one succeeds. */
  const failures = { publish: 0, upsert: 0 };
  const state = memoryState();
  /** The assignees of each open inbox item, by subject. */
  const openNotices = new Map<string, string[]>();
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
      if (failures.publish > 0) {
        failures.publish -= 1;
        throw new Error("The event queue is down");
      }
      recorded.published.push(event);
    },
  };
  const inboxItems: HeartbeatHookContext["inboxItems"] = {
    forConversation(conversationId) {
      return {
        async upsert(notice) {
          if (failures.upsert > 0) {
            failures.upsert -= 1;
            throw new Error("The Inbox is down");
          }
          // Like core: a person joins only when asked, and the item
          // closes when nobody is left. `notices` records each item that
          // opens and each ask that pushes.
          const key = subjectKey(notice.subject);
          const on = openNotices.get(key);
          const wereOn = notice.assigneeIdentityIds.filter((id) =>
            on?.includes(id),
          );
          const assignees = notice.assigneeIdentityIds.filter(
            (id) => notice.askedIdentityIds.includes(id) || on?.includes(id),
          );
          if (assignees.length === 0) {
            if (openNotices.delete(key)) recorded.closedNotices.push(key);
            return wereOn;
          }
          openNotices.set(key, assignees);
          if (on && notice.askedIdentityIds.length === 0) return wereOn;
          recorded.notices.push({ conversationId, notice });
          return wereOn;
        },
        async close(input) {
          const key = subjectKey(input.subject);
          if (!openNotices.delete(key)) return false;
          recorded.closedNotices.push(key);
          return true;
        },
      };
    },
  };
  // Nobody linked a GitHub account.
  const users: HeartbeatHookContext["users"] = {
    async findLinkedIdentityIds() {
      return new Map();
    },
    async readIdentity() {
      return undefined;
    },
  };
  const cache: HeartbeatHookContext["cache"] = {
    async getOrLoad(_key, load) {
      return (await load()).value;
    },
  };

  async function deliver(request: Request): Promise<void> {
    const unused = () => {
      throw new Error("GitHub webhooks do not dispatch agents");
    };
    const annotations: HeartbeatHookContext["annotations"] = {
      forConversation() {
        return {
          async upsert() {},
          async remove() {},
          async list() {
            return [];
          },
        };
      },
    };
    const [route] = githubPlugin().hooks!.routes!({
      agent: { dispatchForIdentity: unused },
      annotations,
      cache,
      codeChanges: {
        async associateConversations() {},
        async recordActivity() {},
        async record() {},
      },
      conversationChanges: conversationChangesThrough({
        annotations,
        batches: recorded.batches,
        inboxItems,
      }),
      db: fixture.db(),
      events,
      log: { error() {}, info() {}, warn() {} },
      plugin: { name: "github" },
      inboxItems,
      state,
      users,
    });
    if (!route) throw new Error("The GitHub plugin has no webhook route");
    const response = await route.handler(request);
    expect(response.status).toBe(202);
  }

  async function heartbeat(nowMs: number): Promise<void> {
    const unused = () => {
      throw new Error("The GitHub heartbeat does not use this");
    };
    const annotations: HeartbeatHookContext["annotations"] = {
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
    };
    await githubPlugin().hooks!.heartbeat!({
      agent: { dispatch: unused, dispatchForIdentity: unused, get: unused },
      annotations,
      cache,
      codeChanges: {
        async associateConversations() {},
        async recordActivity() {},
        async record(input) {
          recorded.codeChanges.push(input);
        },
      },
      conversationChanges: conversationChangesThrough({
        annotations,
        batches: recorded.batches,
        inboxItems,
      }),
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
      inboxItems,
      state,
      users,
    });
  }

  /**
   * A person picks a choice on an open item. Like core, the item stays
   * open, and the plugin gets the answer.
   */
  async function answer(input: {
    choice: string;
    conversationId: string;
    itemId: string;
    nowMs: number;
    subject: { id: string; kind: string };
  }): Promise<void> {
    expect(openNotices.has(subjectKey(input.subject))).toBe(true);
    await githubPlugin().hooks!.inboxItemAnswered!({
      ...input,
      cache,
      db: fixture.db(),
      events,
      log: { error() {}, info() {}, warn() {} },
      plugin: { name: "github" },
      inboxItems,
      state,
      users,
      watches: {
        canSubscribe: true,
        // Only the Conversation's own Watch counts, not `hasMatch`.
        async watching({ eventType, identifier }) {
          return (
            input.conversationId === "slack:C1:1.0" &&
            identifier === "getsentry/junior#946" &&
            eventType === "pull_request.merge_conflict" &&
            watches.ownConflicts
          );
        },
        async subscribe({ events: watched, resource }) {
          recorded.subscribed.push({
            events: watched,
            identifier: resource.identifier,
            publishedBefore: recorded.published.length,
          });
          if (watched.includes("pull_request.merge_conflict")) {
            watches.conflicts = true;
            watches.ownConflicts = true;
          }
          return { events: watched, id: "watch-1" };
        },
      },
    });
  }

  /**
   * A person's Dismiss of an item that only they are on: core closes it and
   * tells the plugin nothing.
   */
  const dismiss = (key: string) => {
    openNotices.delete(key);
  };

  return {
    ...recorded,
    answer,
    deliver,
    dismiss,
    events,
    failures,
    heartbeat,
    inboxItems,
    watches,
  };
}

export type PluginHarness = ReturnType<typeof createPluginHarness>;
