import { defineApiRoute, type ApiRoute } from "../route";
import {
  personalSpendReportSchema,
  type PersonalSpendReport,
} from "../schema/person";
import { requireViewer } from "../viewer";
import { readPersonalSpendFromSql } from "./spend.query";

const PERSONAL_SPEND_CACHE_TTL_MS = 5 * 60_000;

type SpendCacheEntry = {
  expiresAtMs: number;
  report: Promise<PersonalSpendReport>;
};

/** Create the self-only spend route with an app-scoped five-minute cache. */
export function createPersonalSpendRoute(): ApiRoute<
  typeof personalSpendReportSchema
> {
  const cache = new Map<string, SpendCacheEntry>();

  async function read(email: string): Promise<PersonalSpendReport> {
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
  }

  return defineApiRoute({
    method: "get",
    path: "/me/spend",
    responseSchema: personalSpendReportSchema,
    handler: async (context) => {
      const viewer = requireViewer(context);
      return read(viewer.email);
    },
  });
}
