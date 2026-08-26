import { createHash } from "node:crypto";
import type { Lock, StateAdapter } from "chat";
import {
  resourceEventMatchSchema,
  resourceEventMatches,
  resourceEventTypeSchema,
  stableResourceEventMatchKey,
  type ResourceEventData,
  type ResourceEventMatch,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { getStateAdapter } from "@/chat/state/adapter";
import { JUNIOR_THREAD_STATE_TTL_MS } from "@/chat/state/ttl";

// v4 stores conversation id + workspace team only. Destination lives on the conversation.
const RESOURCE_EVENT_PREFIX = "junior:resource_event_subscription:v4";
const INDEX_LOCK_TTL_MS = 10_000;
const SUBSCRIPTION_LOCK_TTL_MS = 10_000;
const SUBSCRIPTION_LOCK_WAIT_MS = 10_000;
const SUBSCRIPTION_LOCK_RETRY_MS = 25;
const SUBSCRIPTION_LOCK_HEARTBEAT_MS = 3_000;

const subscriptionStatusSchema = z.enum(["active", "cancelled", "completed"]);

const subscriptionIdIndexSchema = z.array(z.string().min(1));

const subscriptionSchema = z
  .object({
    conversationId: z.string().min(1),
    createdAtMs: z.number().finite(),
    events: z.array(resourceEventTypeSchema).min(1),
    expiresAtMs: z.number().finite(),
    id: z.string().min(1),
    intent: z.string().min(1),
    label: z.string().min(1),
    match: resourceEventMatchSchema.optional(),
    namespace: z.string().min(1),
    identifier: z.string().min(1),
    resourceType: z.string().min(1),
    status: subscriptionStatusSchema,
    /** Workspace team id for match indexes only. */
    teamId: z.string().min(1),
    updatedAtMs: z.number().finite(),
  })
  .strict();

export type ResourceEventSubscription = z.output<typeof subscriptionSchema>;

export interface CreateResourceEventSubscriptionInput {
  conversationId: string;
  events: string[];
  expiresAtMs: number;
  intent: string;
  label: string;
  match?: ResourceEventMatch;
  namespace: string;
  identifier: string;
  resourceType: string;
  /** Workspace team id for match indexes only. */
  teamId: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function subscriptionKey(id: string): string {
  return `${RESOURCE_EVENT_PREFIX}:record:${id}`;
}

function subscriptionLockKey(id: string): string {
  return `${RESOURCE_EVENT_PREFIX}:lock:${id}`;
}

function resourceIndexKey(
  teamId: string,
  namespace: string,
  identifier: string,
): string {
  return `${RESOURCE_EVENT_PREFIX}:resource:${digest(`${teamId}\0${namespace}\0${identifier}`)}`;
}

function requireTeamId(teamId: string): string {
  const normalized = teamId.trim();
  if (!normalized) {
    throw new Error("Resource event subscriptions require a workspace team id");
  }
  return normalized;
}

function conversationIndexKey(conversationId: string): string {
  return `${RESOURCE_EVENT_PREFIX}:conversation:${digest(conversationId)}`;
}

function indexLockKey(key: string): string {
  return `${key}:lock`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}

async function acquireSubscriptionLock(
  state: StateAdapter,
  subscriptionId: string,
  waitDeadlineMs = Date.now() + SUBSCRIPTION_LOCK_WAIT_MS,
): Promise<Lock> {
  while (true) {
    const lock = await state.acquireLock(
      subscriptionLockKey(subscriptionId),
      SUBSCRIPTION_LOCK_TTL_MS,
    );
    if (lock) {
      return lock;
    }
    if (Date.now() >= waitDeadlineMs) {
      throw new Error(
        `Could not acquire resource event subscription lock for ${subscriptionId}`,
      );
    }
    await sleep(SUBSCRIPTION_LOCK_RETRY_MS);
  }
}

/** Run one subscription lifecycle transition while keeping its lease alive. */
async function withSubscriptionLock<T>(
  state: StateAdapter,
  subscriptionId: string,
  callback: () => Promise<T>,
  waitDeadlineMs?: number,
): Promise<T> {
  const lock = await acquireSubscriptionLock(
    state,
    subscriptionId,
    waitDeadlineMs,
  );
  let lockLostError: Error | undefined;
  let heartbeatError: Error | undefined;
  let heartbeat: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (heartbeat) {
      return;
    }
    heartbeat = state
      .extendLock(lock, SUBSCRIPTION_LOCK_TTL_MS)
      .then((extended) => {
        if (extended) {
          heartbeatError = undefined;
        } else {
          lockLostError = new Error(
            `Resource event subscription lock was lost for ${subscriptionId}`,
          );
        }
      })
      .catch((error: unknown) => {
        heartbeatError =
          error instanceof Error
            ? error
            : new Error(`Failed to extend subscription lock: ${String(error)}`);
      })
      .finally(() => {
        heartbeat = undefined;
      });
  }, SUBSCRIPTION_LOCK_HEARTBEAT_MS);
  timer.unref?.();
  let result: T;
  try {
    result = await callback();
  } finally {
    clearInterval(timer);
    await heartbeat;
    await state.releaseLock(lock);
  }
  const lockError = lockLostError ?? heartbeatError;
  if (lockError) {
    throw lockError;
  }
  return result;
}

function ttlUntil(expiresAtMs: number, nowMs: number): number {
  return Math.max(1, expiresAtMs - nowMs);
}

async function readSubscriptionIdIndex(
  state: StateAdapter,
  key: string,
): Promise<string[]> {
  const value = await state.get(key);
  if (value === undefined || value === null) {
    return [];
  }
  return subscriptionIdIndexSchema.parse(value);
}

function buildSubscriptionId(input: {
  conversationId: string;
  events: string[];
  match?: ResourceEventMatch;
  namespace: string;
  identifier: string;
  teamId: string;
}): string {
  const eventKey = [...new Set(input.events)].sort().join("\0");
  const matchKey = stableResourceEventMatchKey(input.match);
  // Keep the pre-match identity when match is empty so recreating a watch
  // replaces the existing subscription instead of double-delivering.
  const material = matchKey
    ? `${input.teamId}\0${input.namespace}\0${input.identifier}\0${input.conversationId}\0${eventKey}\0${matchKey}`
    : `${input.teamId}\0${input.namespace}\0${input.identifier}\0${input.conversationId}\0${eventKey}`;
  return `resub_${digest(material)}`;
}

async function withIndexLock<T>(
  state: StateAdapter,
  key: string,
  callback: () => Promise<T>,
): Promise<T> {
  const lock = await state.acquireLock(indexLockKey(key), INDEX_LOCK_TTL_MS);
  if (!lock) {
    throw new Error(`Could not acquire resource event index lock for ${key}`);
  }
  try {
    return await callback();
  } finally {
    await state.releaseLock(lock);
  }
}

async function addToIndex(
  state: StateAdapter,
  key: string,
  subscriptionId: string,
  nowMs: number,
): Promise<void> {
  await withIndexLock(state, key, async () => {
    const ids = [...new Set(await readSubscriptionIdIndex(state, key))];
    const next = ids.includes(subscriptionId) ? ids : [...ids, subscriptionId];
    await state.set(key, next, await indexTtlMs(state, next, nowMs));
  });
}

async function removeFromIndex(
  state: StateAdapter,
  key: string,
  subscriptionId: string,
  nowMs: number,
): Promise<void> {
  await withIndexLock(state, key, async () => {
    const existing = await readSubscriptionIdIndex(state, key);
    const next = existing.filter((id) => id !== subscriptionId);
    await state.set(key, next, await indexTtlMs(state, next, nowMs));
  });
}

async function indexTtlMs(
  state: StateAdapter,
  subscriptionIds: string[],
  nowMs: number,
): Promise<number> {
  const records = await Promise.all(
    subscriptionIds.map(async (id) =>
      parseSubscription(await state.get(subscriptionKey(id))),
    ),
  );
  const latestExpiresAtMs = Math.max(
    nowMs,
    ...records
      .filter(
        (record): record is ResourceEventSubscription =>
          record !== undefined && activeAt(record, nowMs),
      )
      .map((record) => record.expiresAtMs),
  );
  return ttlUntil(latestExpiresAtMs, nowMs);
}

function parseSubscription(
  value: unknown,
): ResourceEventSubscription | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return subscriptionSchema.parse(value);
}

function activeAt(
  subscription: ResourceEventSubscription,
  nowMs: number,
): boolean {
  return subscription.status === "active" && subscription.expiresAtMs > nowMs;
}

function matchesEvent(
  subscription: ResourceEventSubscription,
  input: {
    data?: ResourceEventData;
    eventType: string;
    nowMs: number;
    namespace: string;
    identifier: string;
    teamId: string;
  },
): boolean {
  return (
    subscription.namespace === input.namespace &&
    subscription.identifier === input.identifier &&
    subscription.teamId === input.teamId &&
    subscription.events.includes(input.eventType) &&
    activeAt(subscription, input.nowMs) &&
    resourceEventMatches(subscription.match, input.data)
  );
}

/** Create or replace the active subscription for one conversation/resource/event set. */
export async function createResourceEventSubscription(
  input: CreateResourceEventSubscriptionInput,
  options: { nowMs?: number; state?: StateAdapter } = {},
): Promise<ResourceEventSubscription> {
  const state = options.state ?? getStateAdapter();
  await state.connect();
  const nowMs = options.nowMs ?? Date.now();
  const events = [...new Set(input.events.map((event) => event.trim()))].filter(
    Boolean,
  );
  if (events.length === 0) {
    throw new Error("Resource event subscription requires at least one event");
  }
  if (input.expiresAtMs <= nowMs) {
    throw new Error("Resource event subscription expiry must be in the future");
  }
  const match =
    input.match && Object.keys(input.match).length > 0 ? input.match : undefined;
  const teamId = requireTeamId(input.teamId);
  const id = buildSubscriptionId({
    conversationId: input.conversationId,
    events,
    match,
    namespace: input.namespace,
    identifier: input.identifier,
    teamId,
  });
  const record: ResourceEventSubscription = {
    conversationId: input.conversationId,
    createdAtMs: nowMs,
    events,
    expiresAtMs: input.expiresAtMs,
    id,
    intent: input.intent,
    label: input.label,
    ...(match ? { match } : undefined),
    namespace: input.namespace,
    identifier: input.identifier,
    resourceType: input.resourceType,
    status: "active",
    teamId,
    updatedAtMs: nowMs,
  };
  const parsed = subscriptionSchema.parse(record);
  await state.set(
    subscriptionKey(id),
    parsed,
    ttlUntil(parsed.expiresAtMs, nowMs),
  );
  await addToIndex(
    state,
    resourceIndexKey(parsed.teamId, input.namespace, input.identifier),
    id,
    nowMs,
  );
  await addToIndex(
    state,
    conversationIndexKey(input.conversationId),
    id,
    nowMs,
  );
  return parsed;
}

/** List active subscriptions bound to one conversation. */
export async function listResourceEventSubscriptions(input: {
  conversationId: string;
  nowMs?: number;
  state?: StateAdapter;
}): Promise<ResourceEventSubscription[]> {
  const state = input.state ?? getStateAdapter();
  await state.connect();
  const nowMs = input.nowMs ?? Date.now();
  const ids = await readSubscriptionIdIndex(
    state,
    conversationIndexKey(input.conversationId),
  );
  const records = await Promise.all(
    ids.map(async (id) =>
      parseSubscription(await state.get(subscriptionKey(id))),
    ),
  );
  return records
    .filter(
      (record): record is ResourceEventSubscription =>
        record !== undefined &&
        record.conversationId === input.conversationId &&
        activeAt(record, nowMs),
    )
    .sort((left, right) => left.createdAtMs - right.createdAtMs);
}

/** Cancel a current-conversation subscription and remove it from match indexes. */
export async function cancelResourceEventSubscription(input: {
  conversationId: string;
  id: string;
  nowMs?: number;
  state?: StateAdapter;
}): Promise<ResourceEventSubscription | undefined> {
  const state = input.state ?? getStateAdapter();
  await state.connect();
  return await withSubscriptionLock(state, input.id, async () => {
    const current = parseSubscription(
      await state.get(subscriptionKey(input.id)),
    );
    if (!current || current.conversationId !== input.conversationId) {
      return undefined;
    }
    const nowMs = input.nowMs ?? Date.now();
    const next: ResourceEventSubscription = {
      ...current,
      status: "cancelled",
      updatedAtMs: nowMs,
    };
    await state.set(
      subscriptionKey(input.id),
      next,
      JUNIOR_THREAD_STATE_TTL_MS,
    );
    await removeFromIndex(
      state,
      resourceIndexKey(current.teamId, current.namespace, current.identifier),
      input.id,
      nowMs,
    );
    await removeFromIndex(
      state,
      conversationIndexKey(current.conversationId),
      input.id,
      nowMs,
    );
    return next;
  });
}

/** Cancel every active resource event subscription bound to one conversation. */
export async function cancelSubscriptions(input: {
  conversationId: string;
  nowMs?: number;
  state?: StateAdapter;
}): Promise<void> {
  const subscriptions = await listResourceEventSubscriptions(input);
  for (const subscription of subscriptions) {
    await cancelResourceEventSubscription({
      conversationId: input.conversationId,
      id: subscription.id,
      nowMs: input.nowMs,
      state: input.state,
    });
  }
}

/**
 * Collect match keys from active watches for these identifiers and event types.
 * Does not evaluate match values — only reports keys that filters use.
 */
export async function collectResourceEventMatchKeys(input: {
  eventTypes: string[];
  identifiers: string[];
  namespace: string;
  nowMs?: number;
  state?: StateAdapter;
  teamId: string;
}): Promise<string[]> {
  const state = input.state ?? getStateAdapter();
  await state.connect();
  const nowMs = input.nowMs ?? Date.now();
  const eventTypes = new Set(
    input.eventTypes.map((eventType) => eventType.trim()).filter(Boolean),
  );
  if (eventTypes.size === 0) return [];
  const keys = new Set<string>();
  const identifiers = new Set(
    input.identifiers.map((value) => value.trim()).filter(Boolean),
  );
  for (const identifier of identifiers) {
    const ids = await readSubscriptionIdIndex(
      state,
      resourceIndexKey(input.teamId, input.namespace, identifier),
    );
    const records = await Promise.all(
      ids.map(async (id) =>
        parseSubscription(await state.get(subscriptionKey(id))),
      ),
    );
    for (const record of records) {
      if (!record) continue;
      if (record.namespace !== input.namespace) continue;
      if (record.identifier !== identifier) continue;
      if (record.teamId !== input.teamId) continue;
      if (!activeAt(record, nowMs)) continue;
      if (!record.events.some((eventType) => eventTypes.has(eventType))) continue;
      for (const key of Object.keys(record.match ?? {})) {
        keys.add(key);
      }
    }
  }
  return [...keys].sort();
}

/** Find active subscriptions interested in a normalized resource event. */
export async function findMatchingResourceEventSubscriptions(input: {
  data?: ResourceEventData;
  eventType: string;
  nowMs?: number;
  namespace: string;
  identifier: string;
  state?: StateAdapter;
  teamId: string;
}): Promise<ResourceEventSubscription[]> {
  const state = input.state ?? getStateAdapter();
  await state.connect();
  const nowMs = input.nowMs ?? Date.now();
  const ids = await readSubscriptionIdIndex(
    state,
    resourceIndexKey(input.teamId, input.namespace, input.identifier),
  );
  const records = await Promise.all(
    ids.map(async (id) =>
      parseSubscription(await state.get(subscriptionKey(id))),
    ),
  );
  return records.filter(
    (record): record is ResourceEventSubscription =>
      record !== undefined &&
      matchesEvent(record, {
        data: input.data,
        eventType: input.eventType,
        nowMs,
        namespace: input.namespace,
        identifier: input.identifier,
        teamId: input.teamId,
      }),
  );
}

/** Recheck and deliver a matched subscription while holding its status lock. */
export async function deliverResourceEventSubscription(input: {
  data?: ResourceEventData;
  deliver: (subscription: ResourceEventSubscription) => Promise<boolean>;
  eventType: string;
  nowMs?: number;
  namespace: string;
  identifier: string;
  state?: StateAdapter;
  subscription: ResourceEventSubscription;
  teamId: string;
  terminal?: boolean;
  waitDeadlineMs?: number;
}): Promise<boolean> {
  const state = input.state ?? getStateAdapter();
  await state.connect();
  return await withSubscriptionLock(
    state,
    input.subscription.id,
    async () => {
      const nowMs = input.nowMs ?? Date.now();
      const current = parseSubscription(
        await state.get(subscriptionKey(input.subscription.id)),
      );
      if (
        !current ||
        !matchesEvent(current, {
          data: input.data,
          eventType: input.eventType,
          nowMs,
          namespace: input.namespace,
          identifier: input.identifier,
          teamId: input.teamId,
        })
      ) {
        return false;
      }
      const delivered = await input.deliver(current);
      if (input.terminal) {
        const latest = parseSubscription(
          await state.get(subscriptionKey(current.id)),
        );
        if (
          !latest ||
          latest.status !== current.status ||
          latest.updatedAtMs !== current.updatedAtMs
        ) {
          return delivered;
        }
        const next: ResourceEventSubscription = {
          ...current,
          status: "completed",
          updatedAtMs: nowMs,
        };
        await state.set(
          subscriptionKey(current.id),
          next,
          JUNIOR_THREAD_STATE_TTL_MS,
        );
        await removeFromIndex(
          state,
          resourceIndexKey(current.teamId, current.namespace, current.identifier),
          current.id,
          nowMs,
        );
        await removeFromIndex(
          state,
          conversationIndexKey(current.conversationId),
          current.id,
          nowMs,
        );
      }
      return delivered;
    },
    input.waitDeadlineMs,
  );
}
