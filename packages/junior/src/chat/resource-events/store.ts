import { createHash } from "node:crypto";
import type { StateAdapter } from "chat";
import { destinationSchema, type Destination } from "@sentry/junior-plugin-api";
import { z } from "zod";
import { getStateAdapter } from "@/chat/state/adapter";
import { JUNIOR_THREAD_STATE_TTL_MS } from "@/chat/state/ttl";

const RESOURCE_EVENT_PREFIX = "junior:resource_event_subscription";
const INDEX_LOCK_TTL_MS = 10_000;
const SUBSCRIPTION_LOCK_TTL_MS = 10_000;

const subscriptionStatusSchema = z.enum(["active", "cancelled", "completed"]);

const subscriptionIdIndexSchema = z.array(z.string().min(1));

const subscriptionSchema = z
  .object({
    conversationId: z.string().min(1),
    createdAtMs: z.number().finite(),
    destination: destinationSchema,
    events: z.array(z.string().min(1)).min(1),
    expiresAtMs: z.number().finite(),
    id: z.string().min(1),
    intent: z.string().min(1),
    label: z.string().min(1),
    provider: z.string().min(1),
    resourceRef: z.string().min(1),
    resourceType: z.string().min(1),
    status: subscriptionStatusSchema,
    updatedAtMs: z.number().finite(),
  })
  .strict();

export type ResourceEventSubscription = z.output<typeof subscriptionSchema>;

export interface CreateResourceEventSubscriptionInput {
  conversationId: string;
  destination: Destination;
  events: string[];
  expiresAtMs: number;
  intent: string;
  label: string;
  provider: string;
  resourceRef: string;
  resourceType: string;
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

function resourceIndexKey(provider: string, resourceRef: string): string {
  return `${RESOURCE_EVENT_PREFIX}:resource:${digest(`${provider}\0${resourceRef}`)}`;
}

function conversationIndexKey(conversationId: string): string {
  return `${RESOURCE_EVENT_PREFIX}:conversation:${digest(conversationId)}`;
}

function indexLockKey(key: string): string {
  return `${key}:lock`;
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
  provider: string;
  resourceRef: string;
}): string {
  const eventKey = [...new Set(input.events)].sort().join("\0");
  return `resub_${digest(
    `${input.provider}\0${input.resourceRef}\0${input.conversationId}\0${eventKey}`,
  )}`;
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
    eventType: string;
    nowMs: number;
    provider: string;
    resourceRef: string;
  },
): boolean {
  return (
    subscription.provider === input.provider &&
    subscription.resourceRef === input.resourceRef &&
    subscription.events.includes(input.eventType) &&
    activeAt(subscription, input.nowMs)
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
  const id = buildSubscriptionId({
    conversationId: input.conversationId,
    events,
    provider: input.provider,
    resourceRef: input.resourceRef,
  });
  const record: ResourceEventSubscription = {
    conversationId: input.conversationId,
    createdAtMs: nowMs,
    destination: input.destination,
    events,
    expiresAtMs: input.expiresAtMs,
    id,
    intent: input.intent,
    label: input.label,
    provider: input.provider,
    resourceRef: input.resourceRef,
    resourceType: input.resourceType,
    status: "active",
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
    resourceIndexKey(input.provider, input.resourceRef),
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
  const lock = await state.acquireLock(
    subscriptionLockKey(input.id),
    SUBSCRIPTION_LOCK_TTL_MS,
  );
  if (!lock) {
    throw new Error(`Could not acquire subscription lock for ${input.id}`);
  }
  try {
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
      resourceIndexKey(current.provider, current.resourceRef),
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
  } finally {
    await state.releaseLock(lock);
  }
}

/** Find active subscriptions interested in a normalized provider event. */
export async function findMatchingResourceEventSubscriptions(input: {
  eventType: string;
  nowMs?: number;
  provider: string;
  resourceRef: string;
  state?: StateAdapter;
}): Promise<ResourceEventSubscription[]> {
  const state = input.state ?? getStateAdapter();
  await state.connect();
  const nowMs = input.nowMs ?? Date.now();
  const ids = await readSubscriptionIdIndex(
    state,
    resourceIndexKey(input.provider, input.resourceRef),
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
        eventType: input.eventType,
        nowMs,
        provider: input.provider,
        resourceRef: input.resourceRef,
      }),
  );
}

/** Recheck and deliver a matched subscription while holding its status lock. */
export async function deliverResourceEventSubscription(input: {
  deliver: (subscription: ResourceEventSubscription) => Promise<boolean>;
  eventType: string;
  nowMs?: number;
  provider: string;
  resourceRef: string;
  state?: StateAdapter;
  subscription: ResourceEventSubscription;
  terminal?: boolean;
}): Promise<boolean> {
  const state = input.state ?? getStateAdapter();
  await state.connect();
  const lock = await state.acquireLock(
    subscriptionLockKey(input.subscription.id),
    SUBSCRIPTION_LOCK_TTL_MS,
  );
  if (!lock) {
    throw new Error(
      `Resource event subscription delivery lock busy: ${input.subscription.id}`,
    );
  }
  try {
    const nowMs = input.nowMs ?? Date.now();
    const current = parseSubscription(
      await state.get(subscriptionKey(input.subscription.id)),
    );
    if (
      !current ||
      !matchesEvent(current, {
        eventType: input.eventType,
        nowMs,
        provider: input.provider,
        resourceRef: input.resourceRef,
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
        resourceIndexKey(current.provider, current.resourceRef),
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
  } finally {
    await state.releaseLock(lock);
  }
}
