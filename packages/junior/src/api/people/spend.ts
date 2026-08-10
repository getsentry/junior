import type { PersonalSpendReport } from "../schema/person";
import { readPersonalSpendFromSql } from "./spend.query";

const PERSONAL_SPEND_CACHE_TTL_MS = 5 * 60_000;

type SpendCacheEntry = {
  expiresAtMs: number;
  report: Promise<PersonalSpendReport>;
};

/** Create an app-scoped personal-spend reader with a five-minute cache. */
export function createPersonalSpendReader() {
  const cache = new Map<string, SpendCacheEntry>();

  return async function readPersonalSpend(
    email: string,
  ): Promise<PersonalSpendReport> {
    const normalizedEmail = email.trim().toLowerCase();
    const nowMs = Date.now();
    const cached = cache.get(normalizedEmail);
    if (cached && cached.expiresAtMs > nowMs) {
      return cached.report;
    }
    cache.delete(normalizedEmail);

    const report = readPersonalSpendFromSql(normalizedEmail, nowMs);
    const entry = {
      expiresAtMs: nowMs + PERSONAL_SPEND_CACHE_TTL_MS,
      report,
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
