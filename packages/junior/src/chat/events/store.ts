import { createHash } from "node:crypto";
import type { Lock, StateAdapter } from "chat";
import {
  eventMatchSchema,
  eventMatches,
  eventTypeSchema,
  stableEventMatchKey,
  type EventData,
  type EventMatch,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { getStateAdapter, getStateValues } from "@/chat/state/adapter";
import { withLock } from "@/chat/state/locks";
import { JUNIOR_THREAD_STATE_TTL_MS } from "@/chat/state/ttl";
import { TIMER_WATCH_INDEX, updateTimerIndex } from "@/chat/events/timer-index";
import { credentialSubjectSchema } from "@/chat/credentials/context";
import { bindTimerWatchCredentialSubject } from "@/chat/credentials/subject";
import { mapBounded } from "@/chat/fan-out";
import {
  watchCreatorSchema,
  type WatchCreator,
} from "@/chat/events/watch-creator";

// Stores conversation id only. Destination lives on the conversation.
// Keep the deployed Redis key prefix until retained Watches expire.
const EVENT_PREFIX = "junior:resource_event_subscription:v5";
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
    /** Who set the Watch. Its Turns serve that instruction. */
    creator: watchCreatorSchema.optional(),
    /** Timer creator whose grants the timer Turn may use. */
    credentialSubject: credentialSubjectSchema.optional(),
    events: z.array(eventTypeSchema).min(1),
    expiresAtMs: z.number().finite(),
    firesAtMs: z.number().finite().optional(),
    /** Guidance for this Watch only, by event type. */
    guidance: z.record(eventTypeSchema, z.string().min(1)).optional(),
    id: z.string().min(1),
    intent: z.string().min(1),
    label: z.string().min(1),
    match: eventMatchSchema.optional(),
    namespace: z.string().min(1),
    identifier: z.string().min(1),
    /** Event types that this Watch delivers as a Quiet Event. */
    quietEvents: z.array(eventTypeSchema).min(1).optional(),
    resourceType: z.string().min(1),
    status: subscriptionStatusSchema,
    updatedAtMs: z.number().finite(),
  })
  .strict();

export type Watch = z.output<typeof subscriptionSchema>;

export interface CreateWatchInput {
  conversationId: string;
  creator?: WatchCreator | undefined;
  events: string[];
  expiresAtMs: number;
  guidance?: Partial<Record<string, string>> | undefined;
  intent: string;
  label: string;
  match?: EventMatch;
  namespace: string;
  identifier: string;
  quietEvents?: readonly string[] | undefined;
  resourceType: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function subscriptionKey(id: string): string {
  return `${EVENT_PREFIX}:record:${id}`;
}

function subscriptionLockKey(id: string): string {
  return `${EVENT_PREFIX}:lock:${id}`;
}

function resourceIndexKey(namespace: string, identifier: string): string {
  return `${EVENT_PREFIX}:resource:${digest(`${namespace}\0${identifier}`)}`;
}

function conversationIndexKey(conversationId: string): string {
  return `${EVENT_PREFIX}:conversation:${digest(conversationId)}`;
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
  /* oxlint-disable no-await-in-loop -- Poll the lock until it is free or the wait ends. */
  while (true) {
    const lock = await state.acquireLock(
      subscriptionLockKey(subscriptionId),
      SUBSCRIPTION_LOCK_TTL_MS,
    );
    if (lock) {
      return lock;
    }
    if (Date.now() >= waitDeadlineMs) {
      throw new Error(`Could not acquire watch lock for ${subscriptionId}`);
    }
    await sleep(SUBSCRIPTION_LOCK_RETRY_MS);
  }
  /* oxlint-enable no-await-in-loop */
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
            `Watch lock was lost for ${subscriptionId}`,
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
  match?: EventMatch | undefined;
  namespace: string;
  identifier: string;
}): string {
  const eventKey = [...new Set(input.events)].sort().join("\0");
  const matchKey = stableEventMatchKey(input.match);
  // Keep the pre-match identity when match is empty so recreating a watch
  // replaces the existing subscription instead of double-delivering.
  const material = matchKey
    ? `${input.namespace}\0${input.identifier}\0${input.conversationId}\0${eventKey}\0${matchKey}`
    : `${input.namespace}\0${input.identifier}\0${input.conversationId}\0${eventKey}`;
  return `resub_${digest(material)}`;
}

async function withIndexLock<T>(
  state: StateAdapter,
  key: string,
  callback: () => Promise<T>,
): Promise<T> {
  // Parallel Watch writes in one Conversation, such as watchEvents and
  // watchTimer in one step, contend here. Each holder writes a few keys, so
  // wait out even a crashed holder's TTL before calling it a failure.
  const attempt = await withLock(state, indexLockKey(key), callback, {
    ttlMs: INDEX_LOCK_TTL_MS,
    waitMs: INDEX_LOCK_TTL_MS,
  });
  if (!attempt.acquired) {
    throw new Error(`Could not acquire event index lock for ${key}`);
  }
  return attempt.value;
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
  const records = await readSubscriptions(state, subscriptionIds);
  const latestExpiresAtMs = Math.max(
    nowMs,
    ...records
      .filter(
        (record): record is Watch =>
          record !== undefined && activeAt(record, nowMs),
      )
      .map((record) => record.expiresAtMs),
  );
  return ttlUntil(latestExpiresAtMs, nowMs);
}

/** Read many Watch records in one state round trip. */
async function readSubscriptions(
  state: StateAdapter,
  ids: readonly string[],
): Promise<Array<Watch | undefined>> {
  const values = await getStateValues(state, ids.map(subscriptionKey));
  return values.map(parseSubscription);
}

function parseSubscription(value: unknown): Watch | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return subscriptionSchema.parse(value);
}

function activeAt(subscription: Watch, nowMs: number): boolean {
  return subscription.status === "active" && subscription.expiresAtMs > nowMs;
}

function matchesEvent(
  subscription: Watch,
  input: {
    data?: EventData | undefined;
    eventType: string;
    nowMs: number;
    namespace: string;
    identifier: string;
  },
): boolean {
  return (
    subscription.namespace === input.namespace &&
    subscription.identifier === input.identifier &&
    subscription.events.includes(input.eventType) &&
    activeAt(subscription, input.nowMs) &&
    eventMatches(subscription.match, input.data)
  );
}

/** Keep non-empty guidance for events that the Watch receives. */
function watchGuidance(
  guidance: Partial<Record<string, string>> | undefined,
  events: readonly string[],
): Record<string, string> | undefined {
  if (!guidance) return undefined;
  const kept: Record<string, string> = {};
  for (const eventType of events) {
    const text = guidance[eventType]?.trim();
    if (text) kept[eventType] = text;
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/** Whether a Watch delivers this event type as a Quiet Event. */
export function isQuietEvent(
  subscription: Pick<Watch, "quietEvents">,
  eventType: string,
): boolean {
  return subscription.quietEvents?.includes(eventType) === true;
}

/** The event types of a Watch that start a Turn. */
export function turnEvents(
  subscription: Pick<Watch, "events" | "quietEvents">,
): string[] {
  return subscription.events.filter(
    (eventType) => !isQuietEvent(subscription, eventType),
  );
}

/** Create or replace the active subscription for one conversation/resource/event set. */
export async function createWatch(
  input: CreateWatchInput,
  options: { nowMs?: number; state?: StateAdapter | undefined } = {},
): Promise<Watch> {
  const state = options.state ?? getStateAdapter();
  await state.connect();
  const nowMs = options.nowMs ?? Date.now();
  const events = [...new Set(input.events.map((event) => event.trim()))].filter(
    Boolean,
  );
  if (events.length === 0) {
    throw new Error("Watch requires at least one event");
  }
  if (input.expiresAtMs <= nowMs) {
    throw new Error("Watch expiry must be in the future");
  }
  const match =
    input.match && Object.keys(input.match).length > 0
      ? input.match
      : undefined;
  const id = buildSubscriptionId({
    conversationId: input.conversationId,
    events,
    match,
    namespace: input.namespace,
    identifier: input.identifier,
  });
  const guidance = watchGuidance(input.guidance, events);
  // Quiet is not part of the Watch id: a Watch for the same events from
  // watchEvents replaces this one, and its Events start Turns.
  const quietEvents = events.filter((event) =>
    input.quietEvents?.includes(event),
  );
  if (quietEvents.length === events.length) {
    throw new Error("Watch requires at least one event that starts a Turn");
  }
  const record: Watch = {
    conversationId: input.conversationId,
    createdAtMs: nowMs,
    ...(input.creator ? { creator: input.creator } : undefined),
    events,
    expiresAtMs: input.expiresAtMs,
    ...(guidance ? { guidance } : undefined),
    id,
    intent: input.intent,
    label: input.label,
    ...(match ? { match } : undefined),
    namespace: input.namespace,
    identifier: input.identifier,
    ...(quietEvents.length > 0 ? { quietEvents } : undefined),
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
    resourceIndexKey(input.namespace, input.identifier),
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

/** Create a retry-stable timer without keeping a process open. */
export async function createTimerWatch(input: {
  conversationId: string;
  creator?: WatchCreator | undefined;
  creatorUserId?: string;
  toolCallId: string;
  afterMs: number;
  intent: string;
}): Promise<Watch> {
  const state = getStateAdapter();
  await state.connect();
  const identifier = digest(`${input.conversationId}\0${input.toolCallId}`);
  const selector = {
    conversationId: input.conversationId,
    namespace: "junior",
    identifier,
    events: ["timer.fired"],
  };
  const id = buildSubscriptionId(selector);
  return await withSubscriptionLock(state, id, async () => {
    const existing = parseSubscription(await state.get(subscriptionKey(id)));
    if (existing) return existing;
    const nowMs = Date.now();
    const firesAtMs = nowMs + input.afterMs;
    const expiresAtMs = firesAtMs + 24 * 60 * 60 * 1000;
    const credentialSubject = input.creatorUserId
      ? bindTimerWatchCredentialSubject({
          conversationId: input.conversationId,
          userId: input.creatorUserId,
          watchId: id,
        })
      : undefined;
    const record = subscriptionSchema.parse({
      ...selector,
      ...(input.creator ? { creator: input.creator } : undefined),
      ...(credentialSubject ? { credentialSubject } : undefined),
      id,
      firesAtMs,
      expiresAtMs,
      resourceType: "timer",
      label: "Timer",
      intent: input.intent,
      status: "active",
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
    // The due entry precedes the record under the delivery lock. Hold the
    // conversation index lock through publication so another Watch cannot
    // shorten its TTL before this record exists.
    await withIndexLock(
      state,
      conversationIndexKey(input.conversationId),
      async () => {
        const key = conversationIndexKey(input.conversationId);
        const ids = [
          ...new Set([...(await readSubscriptionIdIndex(state, key)), id]),
        ];
        await state.set(
          key,
          ids,
          Math.max(
            ttlUntil(expiresAtMs, nowMs),
            await indexTtlMs(state, ids, nowMs),
          ),
        );
        await state.set(
          resourceIndexKey("junior", identifier),
          [id],
          ttlUntil(expiresAtMs, nowMs),
        );
        await updateTimerIndex(state, TIMER_WATCH_INDEX, {
          kind: "add",
          id,
          atMs: firesAtMs,
        });
        await state.set(
          subscriptionKey(id),
          record,
          ttlUntil(expiresAtMs, nowMs),
        );
      },
    );
    return record;
  });
}

/** Claim live timer Watches and discard stale due-index entries. */
export async function takeDueTimerWatches(nowMs: number): Promise<Watch[]> {
  const state = getStateAdapter();
  await state.connect();
  const watches: Watch[] = [];
  /* oxlint-disable no-await-in-loop -- A stale entry updates the timer index, whose lock does not wait. */
  for (const id of await updateTimerIndex(state, TIMER_WATCH_INDEX, {
    kind: "claim",
    nowMs,
  })) {
    await withSubscriptionLock(state, id, async () => {
      const watch = parseSubscription(await state.get(subscriptionKey(id)));
      if (watch && activeAt(watch, nowMs) && watch.firesAtMs !== undefined) {
        if (watch.firesAtMs <= nowMs) watches.push(watch);
      } else {
        await updateTimerIndex(state, TIMER_WATCH_INDEX, {
          kind: "remove",
          id,
        });
      }
    });
  }
  /* oxlint-enable no-await-in-loop */
  return watches;
}

/** List active subscriptions bound to one conversation. */
export async function listWatches(input: {
  conversationId: string;
  nowMs?: number;
  state?: StateAdapter | undefined;
}): Promise<Watch[]> {
  const state = input.state ?? getStateAdapter();
  await state.connect();
  const nowMs = input.nowMs ?? Date.now();
  const ids = await readSubscriptionIdIndex(
    state,
    conversationIndexKey(input.conversationId),
  );
  const records = await readSubscriptions(state, ids);
  return records
    .filter(
      (record): record is Watch =>
        record !== undefined &&
        record.conversationId === input.conversationId &&
        activeAt(record, nowMs),
    )
    .sort((left, right) => left.createdAtMs - right.createdAtMs);
}

/**
 * Return which of these Conversations have an active Watch or Timer. It reads
 * the Conversation indexes in one batch, then the Watches in one batch, so a
 * page of Conversations costs two state reads.
 */
export async function listConversationsWithWatches(input: {
  conversationIds: readonly string[];
}): Promise<Set<string>> {
  if (input.conversationIds.length === 0) return new Set();
  const state = getStateAdapter();
  await state.connect();
  const nowMs = Date.now();
  const indexes = await getStateValues(
    state,
    input.conversationIds.map(conversationIndexKey),
  );
  const ids = indexes.flatMap((value) =>
    value === undefined || value === null
      ? []
      : subscriptionIdIndexSchema.parse(value),
  );
  const records = await readSubscriptions(state, ids);
  const wanted = new Set(input.conversationIds);
  return new Set(
    records.flatMap((record) =>
      record && wanted.has(record.conversationId) && activeAt(record, nowMs)
        ? [record.conversationId]
        : [],
    ),
  );
}

/**
 * Read one watch by id in any status. The caller checks that its Conversation
 * owns the watch before it acts on it.
 */
export async function getWatch(input: {
  id: string;
  state?: StateAdapter;
}): Promise<Watch | undefined> {
  const state = input.state ?? getStateAdapter();
  await state.connect();
  return parseSubscription(await state.get(subscriptionKey(input.id)));
}

/** Cancel a current-conversation subscription and remove it from match indexes. */
export async function cancelWatch(input: {
  conversationId: string;
  id: string;
  nowMs?: number | undefined;
  state?: StateAdapter | undefined;
}): Promise<Watch | undefined> {
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
    if (current.status === "completed") return current;
    const next: Watch = {
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
      resourceIndexKey(current.namespace, current.identifier),
      input.id,
      nowMs,
    );
    await removeFromIndex(
      state,
      conversationIndexKey(current.conversationId),
      input.id,
      nowMs,
    );
    if (current.firesAtMs !== undefined)
      await updateTimerIndex(state, TIMER_WATCH_INDEX, {
        kind: "remove",
        id: input.id,
      });
    return next;
  });
}

/** Cancel every active watch bound to one conversation. */
export async function cancelSubscriptions(input: {
  conversationId: string;
  nowMs?: number;
  state?: StateAdapter | undefined;
}): Promise<void> {
  const subscriptions = await listWatches(input);
  /* oxlint-disable no-await-in-loop -- Each cancel updates the timer index, whose lock does not wait. */
  for (const subscription of subscriptions) {
    await cancelWatch({
      conversationId: input.conversationId,
      id: subscription.id,
      nowMs: input.nowMs,
      state: input.state,
    });
  }
  /* oxlint-enable no-await-in-loop */
}

/**
 * Collect match keys from active watches for these identifiers and event types.
 * Does not evaluate match values — only reports keys that filters use.
 */
export async function collectEventMatchKeys(input: {
  eventTypes: string[];
  identifiers: string[];
  namespace: string;
  nowMs?: number;
  state?: StateAdapter | undefined;
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
  const recordsByIdentifier = await mapBounded(
    identifiers,
    async (identifier) => {
      const ids = await readSubscriptionIdIndex(
        state,
        resourceIndexKey(input.namespace, identifier),
      );
      return { identifier, records: await readSubscriptions(state, ids) };
    },
  );
  for (const { identifier, records } of recordsByIdentifier) {
    for (const record of records) {
      if (!record) continue;
      if (record.namespace !== input.namespace) continue;
      if (record.identifier !== identifier) continue;
      if (!activeAt(record, nowMs)) continue;
      if (!record.events.some((eventType) => eventTypes.has(eventType)))
        continue;
      for (const key of Object.keys(record.match ?? {})) {
        keys.add(key);
      }
    }
  }
  return [...keys].sort();
}

/** Find active subscriptions interested in a normalized event. */
export async function findMatchingWatches(input: {
  data?: EventData | undefined;
  eventType: string;
  nowMs?: number;
  namespace: string;
  identifier: string;
  state?: StateAdapter | undefined;
}): Promise<Watch[]> {
  const state = input.state ?? getStateAdapter();
  await state.connect();
  const nowMs = input.nowMs ?? Date.now();
  const ids = await readSubscriptionIdIndex(
    state,
    resourceIndexKey(input.namespace, input.identifier),
  );
  const records = await readSubscriptions(state, ids);
  return records.filter(
    (record): record is Watch =>
      record !== undefined &&
      matchesEvent(record, {
        data: input.data,
        eventType: input.eventType,
        nowMs,
        namespace: input.namespace,
        identifier: input.identifier,
      }),
  );
}

/** Recheck and deliver a matched subscription while holding its status lock. */
export async function deliverWatch(input: {
  data?: EventData | undefined;
  deliver: (subscription: Watch) => Promise<boolean>;
  eventType: string;
  nowMs?: number;
  namespace: string;
  identifier: string;
  state?: StateAdapter | undefined;
  subscription: Watch;
  terminal?: boolean | undefined;
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
        const next: Watch = {
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
          resourceIndexKey(current.namespace, current.identifier),
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
      if (input.terminal && current.firesAtMs !== undefined) {
        await updateTimerIndex(state, TIMER_WATCH_INDEX, {
          kind: "remove",
          id: current.id,
        });
      }
      return delivered;
    },
    input.waitDeadlineMs,
  );
}
