/**
 * Re-encryption sweep for stored credentials.
 *
 * One mechanism moves stored values to the active encryption key. Plain text
 * is a value with no key id, so the same sweep migrates plain-text tokens and
 * rotates old keys.
 *
 * Rules:
 * - Each run is one bounded batch. The `SCAN` cursor is stored between runs.
 * - A rewrite is a compare-and-set that keeps the TTL. It never overwrites a
 *   value that a token refresh changed after the sweep read it.
 * - The sweep keeps cycling through the keyspace, so values that old
 *   deployments write during a rollout are found on a later pass.
 * - `lastCleanPassAt` is set only while the most recent full pass under the
 *   active key found no value to change. Remove an old key only then.
 * - One batch runs at a time. An overlapping run returns `busy` so it cannot
 *   move the stored cursor or progress counts.
 * - Only the Redis state adapter is swept. The memory adapter loses its values
 *   when the process stops, so it has nothing durable to migrate.
 */
import { z } from "zod";
import { MCP_AUTH_CREDENTIALS_PREFIX } from "@/chat/mcp/auth-store";
import { logInfo } from "@/chat/logging";
import {
  getConnectedStateContext,
  getRedisCacheKeyPrefix,
} from "@/chat/state/adapter";
import {
  CredentialDecryptionError,
  decryptStoredCredential,
  encryptStoredCredential,
  readCredentialKeyRing,
  storedCredentialKeyId,
  type CredentialKeyRing,
} from "@/chat/credentials/encryption";
import { USER_TOKEN_KEY_PREFIX } from "@/chat/credentials/state-adapter-token-store";

const PROGRESS_KEY = "junior:credential_sweep";
const LOCK_KEY = `${PROGRESS_KEY}:lock`;
// Longer than one batch can run, so a stuck run cannot block the sweep for long.
const LOCK_TTL_MS = 5 * 60 * 1000;
const PROGRESS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SCAN_COUNT = 1000;
const MAX_SCANS_PER_BATCH = 10;
const CREDENTIAL_KEY_PREFIXES = [
  `${USER_TOKEN_KEY_PREFIX}:`,
  `${MCP_AUTH_CREDENTIALS_PREFIX}:`,
];

// Write ARGV[2] only if the key still holds ARGV[1]. Keep the remaining TTL.
const COMPARE_AND_SET_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl > 0 then
  redis.call('SET', KEYS[1], ARGV[2], 'PX', ttl)
else
  redis.call('SET', KEYS[1], ARGV[2])
end
return 1`;

const progressSchema = z
  .object({
    cursor: z.string().min(1),
    keyId: z.string().min(1),
    lastCleanPassAtMs: z.number().finite().optional(),
    passChanges: z.number().int().nonnegative(),
  })
  .strict();

type Progress = z.output<typeof progressSchema>;

/** Outcome of one sweep batch. */
export interface CredentialSweepResult {
  /** Values this batch read from the credential stores. */
  examined: number;
  /** Values that changed after the sweep read them. The next pass retries them. */
  conflicts: number;
  keyId?: string;
  /** Set only when the most recent full pass found no value to change. */
  lastCleanPassAt?: string;
  reencrypted: number;
  status: "disabled" | "unsupported" | "busy" | "running" | "pass_complete";
  /** Values that do not decrypt with any configured key. */
  unreadable: number;
}

/**
 * Re-encrypt one raw Redis value with the active key.
 *
 * `raw` is the JSON text that the state adapter stored. Returns the new raw
 * text, or `undefined` when the value already uses the active key. Throws
 * `CredentialDecryptionError` when an encrypted value does not decrypt.
 */
export function reencryptStoredValue(
  raw: string,
  recordKey: string,
  keyRing: CredentialKeyRing,
): string | undefined {
  const stored: unknown = JSON.parse(raw);
  if (storedCredentialKeyId(stored) === keyRing.activeKeyId) {
    return undefined;
  }
  const value = decryptStoredCredential(stored, recordKey, keyRing);
  return JSON.stringify(encryptStoredCredential(value, recordKey, keyRing));
}

/** Run one bounded re-encryption batch over the stored credential keys. */
export async function runCredentialSweep(): Promise<CredentialSweepResult> {
  const result: CredentialSweepResult = {
    conflicts: 0,
    examined: 0,
    reencrypted: 0,
    status: "disabled",
    unreadable: 0,
  };
  const keyRing = readCredentialKeyRing();
  const activeKeyId = keyRing?.activeKeyId;
  if (!keyRing || !activeKeyId) {
    return result;
  }
  result.keyId = activeKeyId;

  const { redisStateAdapter, stateAdapter } = await getConnectedStateContext();
  if (!redisStateAdapter) {
    return { ...result, status: "unsupported" };
  }
  const lock = await stateAdapter.acquireLock(LOCK_KEY, LOCK_TTL_MS);
  if (!lock) {
    return { ...result, status: "busy" };
  }

  try {
    const client = redisStateAdapter.getClient();
    const cachePrefix = getRedisCacheKeyPrefix();
    const saved = progressSchema.safeParse(
      await stateAdapter.get(PROGRESS_KEY),
    );
    const progress: Progress =
      saved.success && saved.data.keyId === activeKeyId
        ? saved.data
        : { cursor: "0", keyId: activeKeyId, passChanges: 0 };

    result.status = "running";
    for (let scan = 0; scan < MAX_SCANS_PER_BATCH; scan += 1) {
      const [nextCursor, keys] = await client.sendCommand<[string, string[]]>([
        "SCAN",
        progress.cursor,
        "MATCH",
        `${cachePrefix}*`,
        "COUNT",
        String(SCAN_COUNT),
      ]);
      for (const redisKey of keys) {
        const recordKey = redisKey.slice(cachePrefix.length);
        if (!CREDENTIAL_KEY_PREFIXES.some((p) => recordKey.startsWith(p))) {
          continue;
        }
        const raw = await client.sendCommand<string | null>(["GET", redisKey]);
        if (raw === null) {
          continue;
        }
        result.examined += 1;
        let next: string | undefined;
        try {
          next = reencryptStoredValue(raw, recordKey, keyRing);
        } catch (error) {
          if (!(error instanceof CredentialDecryptionError)) {
            throw error;
          }
          // Leave the value in place. The pass must not report clean while
          // a value stays unreadable.
          result.unreadable += 1;
          progress.passChanges += 1;
          continue;
        }
        if (next === undefined) {
          continue;
        }
        progress.passChanges += 1;
        const written = await client.sendCommand<number>([
          "EVAL",
          COMPARE_AND_SET_SCRIPT,
          "1",
          redisKey,
          raw,
          next,
        ]);
        if (written === 1) {
          result.reencrypted += 1;
        } else {
          result.conflicts += 1;
        }
      }

      progress.cursor = nextCursor;
      if (nextCursor === "0") {
        result.status = "pass_complete";
        progress.lastCleanPassAtMs =
          progress.passChanges === 0 ? Date.now() : undefined;
        progress.passChanges = 0;
        break;
      }
    }
    await stateAdapter.set(PROGRESS_KEY, progress, PROGRESS_TTL_MS);

    const attributes: Record<string, string | number> = {
      "app.credential_sweep.status": result.status,
      "app.credential_sweep.key_id": activeKeyId,
      "app.credential_sweep.examined": result.examined,
      "app.credential_sweep.reencrypted": result.reencrypted,
      "app.credential_sweep.conflicts": result.conflicts,
      "app.credential_sweep.unreadable": result.unreadable,
    };
    if (progress.lastCleanPassAtMs !== undefined) {
      result.lastCleanPassAt = new Date(
        progress.lastCleanPassAtMs,
      ).toISOString();
      attributes["app.credential_sweep.last_clean_pass_at"] =
        result.lastCleanPassAt;
    }
    logInfo("credential_sweep.batch.completed", attributes);
    return result;
  } finally {
    await stateAdapter.releaseLock(lock);
  }
}
