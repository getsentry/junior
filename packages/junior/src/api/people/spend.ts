import type { PersonalSpendReport } from "../schema/person";
import {
  readPersonalSpendFromSql,
  readPersonalSpendVersion,
} from "./spend.query";

const PERSONAL_SPEND_CACHE_TTL_MS = 5 * 60_000;

type SpendCacheEntry = {
  expiresAtMs: number;
  report: Promise<PersonalSpendReport>;
  version: string;
};

/**
 * Create an app-scoped personal-spend reader.
 *
 * A cached report stays valid for five minutes, or until the viewer's spend
 * version changes. The dashboard can poll often and still see a finished Turn
 * without a full aggregate query on every poll.
 */
export function createPersonalSpendReader() {
  const cache = new Map<string, SpendCacheEntry>();

  return async function readPersonalSpend(
    email: string,
  ): Promise<PersonalSpendReport> {
    const normalizedEmail = email.trim().toLowerCase();
    const nowMs = Date.now();
    const version = await readPersonalSpendVersion(normalizedEmail, nowMs);
    const cached = cache.get(normalizedEmail);
    if (cached && cached.expiresAtMs > nowMs && cached.version === version) {
      return cached.report;
    }
    cache.delete(normalizedEmail);

    const report = readPersonalSpendFromSql(normalizedEmail, nowMs);
    const entry = {
      expiresAtMs: nowMs + PERSONAL_SPEND_CACHE_TTL_MS,
      report,
      version,
    };
    cache.set(normalizedEmail, entry);
    try {
      return await report;
    } catch (error) {
      if (cache.get(normalizedEmail) === entry) cache.delete(normalizedEmail);
      throw error;
    }
  };
}
