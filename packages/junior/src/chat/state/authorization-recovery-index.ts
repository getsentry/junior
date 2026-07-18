import { THREAD_STATE_TTL_MS, type StateAdapter } from "chat";
import { z } from "zod";

const AUTHORIZATION_RECOVERY_INDEX_KEY =
  "junior:agent_turn_authorization_recovery:index";
const AUTHORIZATION_RECOVERY_INDEX_LOCK_KEY =
  "junior:agent_turn_authorization_recovery:index-lock";
const AUTHORIZATION_RECOVERY_INDEX_LOCK_TTL_MS = 10_000;

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
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = authorizationRecoveryIndexEntrySchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
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
    return [
      ...entries.filter((candidate) => entryKey(candidate) !== key),
      parsed,
    ];
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
