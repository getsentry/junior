import { afterEach, describe, expect, test } from "vitest";
import { createJuniorApi } from "@/api";
import { replyTimeSegmentsReportSchema } from "@/api/schema";
import { NO_REPLY_GAP_MS } from "@/chat/cache-warming/model";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";

const MINUTE = 60_000;
const KEY = "junior:cache_warming:gaps:user:1:none";

describe("reply time segments API", () => {
  afterEach(async () => {
    await getStateAdapter().delete(KEY);
    await disconnectStateAdapter();
  });

  test("serves the gap list of each segment in the model bins", async () => {
    const state = getStateAdapter();
    await state.connect();
    for (const gapMs of [5_000, 8 * MINUTE, NO_REPLY_GAP_MS]) {
      await state.appendToList(KEY, gapMs);
    }

    const response = await createJuniorApi().request(
      "http://localhost/api/reply-times",
    );
    expect(response.status).toBe(200);
    const report = replyTimeSegmentsReportSchema.parse(await response.json());

    expect(report.minSamples).toBe(20);
    expect(report.segments).toHaveLength(21);
    const segment = report.segments.find(
      (entry) => entry.segment === "user:1:none",
    );
    expect(segment?.histogram).toMatchObject({ noReply: 1, total: 3 });
    expect(segment?.histogram.bins.filter((bin) => bin.count > 0)).toEqual([
      { startMs: 0, endMs: 10_000, count: 1 },
      { startMs: 7 * MINUTE, endMs: 10 * MINUTE, count: 1 },
    ]);
    expect(segment?.histogram.bins.at(-1)).toMatchObject({
      endMs: 55 * MINUTE,
    });
    expect(
      report.segments.find((entry) => entry.segment === "archived:open")
        ?.histogram.total,
    ).toBe(0);
  });
});
