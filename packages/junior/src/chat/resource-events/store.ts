import { createHash } from "node:crypto";
import type { StateAdapter } from "chat";
import {
  destinationSchema,
  requesterSchema,
  sourceSchema,
  type Destination,
  type Requester,
  type Source,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { getStateAdapter } from "@/chat/state/adapter";
import { JUNIOR_THREAD_STATE_TTL_MS } from "@/chat/state/ttl";

const RESOURCE_EVENT_PREFIX = "junior:resource_event_subscription";
const INDEX_LOCK_TTL_MS = 10_000;
const SUBSCRIPTION_LOCK_TTL_MS = 10_000;
const INDEX_MAX_LENGTH = 10_000;

const subscriptionStatusSchema = z.enum([
  "active",
  "cancelled",
  "completed",
  "expired",
]);

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
    requester: requesterSchema.optional(),
    resourceRef: z.string().min(1),
    resourceType: z.string().min(1),
    source: sourceSchema,
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
  requester?: Requester;
  resourceRef: string;
  resourceType: string;
  source: Source;
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
): Promise<void> {
  await withIndexLock(state, key, async () => {
    const existing = (await state.get<string[]>(key)) ?? [];
    const ids = [
      ...new Set(existing.filter((id): id is string => typeof id === "string")),
    ];
    const next = ids.includes(subscriptionId)
      ? ids
      : [...ids, subscriptionId].slice(-INDEX_MAX_LENGTH);
    await state.set(key, next, JUNIOR_THREAD_STATE_TTL_MS);
  });
}

async function removeFromIndex(
  state: StateAdapter,
  key: string,
  subscriptionId: string,
): Promise<void> {
  await withIndexLock(state, key, async () => {
    const existing = (await state.get<string[]>(key)) ?? [];
    const next = existing.filter((id) => id !== subscriptionId);
    await state.set(key, next, JUNIOR_THREAD_STATE_TTL_MS);
  });
}

function parseSubscription(
  value: unknown,
): ResourceEventSubscription | undefined {
  const parsed = subscriptionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function activeAt(
  subscription: ResourceEventSubscription,
  nowMs: number,
): boolean {
  return subscription.status === "active" && subscription.expiresAtMs > nowMs;
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
    ...(input.requester ? { requester: input.requester } : {}),
    resourceRef: input.resourceRef,
    resourceType: input.resourceType,
    source: input.source,
    status: "active",
    updatedAtMs: nowMs,
  };
  const parsed = subscriptionSchema.parse(record);
  await state.set(subscriptionKey(id), parsed, JUNIOR_THREAD_STATE_TTL_MS);
  await addToIndex(
    state,
    resourceIndexKey(input.provider, input.resourceRef),
    id,
  );
  await addToIndex(state, conversationIndexKey(input.conversationId), id);
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
  const ids =
    (await state.get<string[]>(conversationIndexKey(input.conversationId))) ??
    [];
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
    const next: ResourceEventSubscription = {
      ...current,
      status: "cancelled",
      updatedAtMs: input.nowMs ?? Date.now(),
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
    );
    await removeFromIndex(
      state,
      conversationIndexKey(current.conversationId),
      input.id,
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
  const ids =
    (await state.get<string[]>(
      resourceIndexKey(input.provider, input.resourceRef),
    )) ?? [];
  const records = await Promise.all(
    ids.map(async (id) =>
      parseSubscription(await state.get(subscriptionKey(id))),
    ),
  );
  return records.filter(
    (record): record is ResourceEventSubscription =>
      record !== undefined &&
      record.provider === input.provider &&
      record.resourceRef === input.resourceRef &&
      record.events.includes(input.eventType) &&
      activeAt(record, nowMs),
  );
}

/** Mark terminal subscriptions completed after their event notification is accepted. */
export async function completeResourceEventSubscription(input: {
  id: string;
  nowMs?: number;
  state?: StateAdapter;
}): Promise<void> {
  const state = input.state ?? getStateAdapter();
  await state.connect();
  const current = parseSubscription(await state.get(subscriptionKey(input.id)));
  if (!current) {
    return;
  }
  const next: ResourceEventSubscription = {
    ...current,
    status: "completed",
    updatedAtMs: input.nowMs ?? Date.now(),
  };
  await state.set(subscriptionKey(input.id), next, JUNIOR_THREAD_STATE_TTL_MS);
  await removeFromIndex(
    state,
    resourceIndexKey(current.provider, current.resourceRef),
    input.id,
  );
  await removeFromIndex(
    state,
    conversationIndexKey(current.conversationId),
    input.id,
  );
}
