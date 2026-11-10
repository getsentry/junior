import type {
  ReplyTimeHistogram,
  ReplyTimeSegmentsReport,
} from "@sentry/junior/api/schema";
import { NOW } from "./fixtures";

const MINUTE_MS = 60_000;
// The cache warming bins up to the 55 minute horizon.
const BIN_EDGES_MS = [
  10_000,
  20_000,
  30_000,
  45_000,
  MINUTE_MS,
  1.5 * MINUTE_MS,
  2 * MINUTE_MS,
  3 * MINUTE_MS,
  4 * MINUTE_MS,
  5 * MINUTE_MS,
  7 * MINUTE_MS,
  10 * MINUTE_MS,
  15 * MINUTE_MS,
  20 * MINUTE_MS,
  30 * MINUTE_MS,
  45 * MINUTE_MS,
  55 * MINUTE_MS,
];
const MIN_SAMPLES = 20;

// Spread `replies` over the bins with most of them near `peakBin`, and add
// `noReply` gaps. The shape is fixed, so screenshots stay the same.
function histogram(args: {
  noReply: number;
  peakBin: number;
  replies: number;
}): ReplyTimeHistogram {
  const weights = BIN_EDGES_MS.map(
    (_, index) => 1 / (1 + (index - args.peakBin) ** 2 / 3),
  );
  const sum = weights.reduce((total, weight) => total + weight, 0);
  const counts = weights.map((weight) =>
    Math.floor((weight / sum) * args.replies),
  );
  counts[args.peakBin]! +=
    args.replies - counts.reduce((total, count) => total + count, 0);
  return {
    bins: BIN_EDGES_MS.map((endMs, index) => ({
      count: counts[index]!,
      endMs,
      startMs: index > 0 ? BIN_EDGES_MS[index - 1]! : 0,
    })),
    noReply: args.noReply,
    total: args.replies + args.noReply,
  };
}

const segments: Array<[string, Parameters<typeof histogram>[0]]> = [
  ["user:1:open", { noReply: 9, peakBin: 7, replies: 31 }],
  ["user:1:done", { noReply: 7, peakBin: 9, replies: 5 }],
  ["user:1:none", { noReply: 520, peakBin: 6, replies: 880 }],
  ["user:2-3:open", { noReply: 8, peakBin: 8, replies: 22 }],
  ["user:2-3:done", { noReply: 4, peakBin: 10, replies: 2 }],
  ["user:2-3:none", { noReply: 410, peakBin: 7, replies: 590 }],
  ["user:4+:open", { noReply: 6, peakBin: 8, replies: 19 }],
  ["user:4+:done", { noReply: 3, peakBin: 11, replies: 1 }],
  ["user:4+:none", { noReply: 380, peakBin: 8, replies: 420 }],
  ["system:1:open", { noReply: 14, peakBin: 12, replies: 12 }],
  ["system:1:done", { noReply: 5, peakBin: 13, replies: 0 }],
  ["system:1:none", { noReply: 610, peakBin: 12, replies: 140 }],
  ["system:2-3:open", { noReply: 9, peakBin: 12, replies: 6 }],
  ["system:2-3:done", { noReply: 2, peakBin: 13, replies: 0 }],
  ["system:2-3:none", { noReply: 290, peakBin: 11, replies: 70 }],
  ["system:4+:open", { noReply: 4, peakBin: 12, replies: 3 }],
  ["system:4+:done", { noReply: 1, peakBin: 13, replies: 0 }],
  ["system:4+:none", { noReply: 150, peakBin: 11, replies: 45 }],
  ["archived:open", { noReply: 6, peakBin: 13, replies: 8 }],
  ["archived:done", { noReply: 3, peakBin: 13, replies: 0 }],
  ["archived:none", { noReply: 0, peakBin: 13, replies: 0 }],
];

/** Return fixed cache warming gap histograms for each segment. */
export function readMockReplyTimeSegments(): ReplyTimeSegmentsReport {
  return {
    generatedAt: NOW,
    minSamples: MIN_SAMPLES,
    segments: segments.map(([segment, gaps]) => ({
      histogram: histogram(gaps),
      segment,
    })),
  };
}
