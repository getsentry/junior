import { THREAD_STATE_TTL_MS, type StateAdapter } from "chat";
import { z } from "zod";

const AUTHORIZATION_RECOVERY_INDEX_KEY =
  "junior:agent_turn_authorization_recovery:index";
const AUTHORIZATION_RECOVERY_INDEX_LOCK_KEY =
  "junior:agent_turn_authorization_recovery:index-lock";
const AUTHORIZATION_RECOVERY_INDEX_LOCK_TTL_MS = 10_000;
/** Maximum unresolved callbacks heartbeat can inspect in one bounded pass. */
export const AUTHORIZATION_RECOVERY_INDEX_MAX_ENTRIES = 1_000;
/** Time allowed for registration to finish its authoritative session write. */
export const AUTHORIZATION_RECOVERY_MISSING_RECORD_GRACE_MS = 5 * 60_000;

const authorizationRecoveryIndexEntrySchema = z
  .object({
    authorizationCompletionId: z.string().min(1),
    conversationId: z.string().min(1),
    registeredAtMs: z.number().finite().nonnegative(),
    sessionId: z.string().min(1),
  })
  .strict();

/** One unresolved authorization callback recovery discoverable by heartbeat. */
export type AuthorizationRecoveryIndexEntry = z.output<
  typeof authorizationRecoveryIndexEntrySchema
>;

function parseEntries(value: unknown): AuthorizationRecoveryIndexEntry[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("Authorization recovery index is malformed");
  }
  if (value.length > AUTHORIZATION_RECOVERY_INDEX_MAX_ENTRIES) {
    throw new Error("Authorization recovery index exceeds capacity");
  }
  const entries: AuthorizationRecoveryIndexEntry[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const parsed = authorizationRecoveryIndexEntrySchema.safeParse(
      value[index],
    );
    if (!parsed.success) {
      throw new Error("Authorization recovery index is malformed");
    }
    entries.push(parsed.data);
  }
  return entries;
}

function entryKey(entry: AuthorizationRecoveryIndexEntry): string {
  return `${entry.conversationId}\0${entry.sessionId}\0${entry.authorizationCompletionId}`;
}

function retainedEntries(
  entries: AuthorizationRecoveryIndexEntry[],
  nowMs: number,
): AuthorizationRecoveryIndexEntry[] {
  const oldestRetainedAtMs = nowMs - THREAD_STATE_TTL_MS;
  return entries.filter((entry) => entry.registeredAtMs >= oldestRetainedAtMs);
}

async function mutateIndex(
  state: StateAdapter,
  nowMs: number,
  mutate: (
    entries: AuthorizationRecoveryIndexEntry[],
  ) => AuthorizationRecoveryIndexEntry[],
): Promise<void> {
  await state.connect();
  const lock = await state.acquireLock(
    AUTHORIZATION_RECOVERY_INDEX_LOCK_KEY,
    AUTHORIZATION_RECOVERY_INDEX_LOCK_TTL_MS,
  );
  if (!lock) {
    throw new Error("Authorization recovery index is busy");
  }
  try {
    const current = retainedEntries(
      parseEntries(await state.get<unknown>(AUTHORIZATION_RECOVERY_INDEX_KEY)),
      nowMs,
    );
    const next = mutate(current);
    if (next.length === 0) {
      await state.delete(AUTHORIZATION_RECOVERY_INDEX_KEY);
      return;
    }
    await state.set(
      AUTHORIZATION_RECOVERY_INDEX_KEY,
      next,
      THREAD_STATE_TTL_MS,
    );
  } finally {
    await state.releaseLock(lock);
  }
}

/** Register an auth recovery before its one-time provider code is consumed. */
export async function registerAuthorizationRecovery(
  state: StateAdapter,
  entry: AuthorizationRecoveryIndexEntry,
): Promise<void> {
  const parsed = authorizationRecoveryIndexEntrySchema.parse(entry);
  await mutateIndex(state, Date.now(), (entries) => {
    const key = entryKey(parsed);
    const existingIndex = entries.findIndex(
      (candidate) => entryKey(candidate) === key,
    );
    if (existingIndex >= 0) {
      const next = [...entries];
      next[existingIndex] = parsed;
      return next;
    }
    if (entries.length >= AUTHORIZATION_RECOVERY_INDEX_MAX_ENTRIES) {
      throw new Error("Authorization recovery index is at capacity");
    }
    return [...entries, parsed];
  });
}

/** Remove one exact recovery without deleting a newer callback attempt. */
export async function removeAuthorizationRecovery(
  state: StateAdapter,
  entry: Pick<
    AuthorizationRecoveryIndexEntry,
    "authorizationCompletionId" | "conversationId" | "sessionId"
  >,
): Promise<void> {
  await mutateIndex(state, Date.now(), (entries) => {
    const key = entryKey({ ...entry, registeredAtMs: 0 });
    return entries.filter((candidate) => entryKey(candidate) !== key);
  });
}

/** List retained recoveries; per-session records remain authoritative. */
export async function listAuthorizationRecoveries(
  state: StateAdapter,
  nowMs = Date.now(),
): Promise<AuthorizationRecoveryIndexEntry[]> {
  await state.connect();
  return retainedEntries(
    parseEntries(await state.get<unknown>(AUTHORIZATION_RECOVERY_INDEX_KEY)),
    nowMs,
  );
}
