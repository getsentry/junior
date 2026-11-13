/**
 * Re-fill of the cache warming savings counters from stored Conversation
 * history. A Junior admin starts it from the System page.
 *
 * Live recording (`savings.ts`) counts only idle periods and tool waits that
 * end after it is deployed. A re-fill replays the stored model calls of the
 * last `REFILL_DAYS` with the same rules into the days before the first day
 * with live counters. It replaces those days, so a second re-fill does not
 * add to the first. It never writes a live day: live days have data that
 * history does not, the real warmup cost and the warm state split.
 *
 * The start request only stores a pending job. The heartbeat runs one slice
 * of the scan each minute, with a time budget. Each slice keeps its sums and
 * the scan position in the job with one state write, so a retried slice does
 * not count twice. The last slice replaces the days in one transaction. A
 * job whose lease expires, because its slices stopped or kept failing, is
 * failed, and an admin can start a new one.
 */
import { randomUUID } from "node:crypto";
import * as z from "zod";
import { logInfo, withSpan } from "@/chat/logging";
import { resolveGatewayModel } from "@/chat/pi/client";
import {
  BACKFILL_BUDGET_MS,
  countHistoryConversations,
  scanIdlePeriodSlice,
  type ReplayedToolWait,
} from "./backfill";
import { MINUTE_MS } from "./model";
import { connectedState, providerCacheTtlMs } from "./request";
import {
  addHistoryPeriod,
  firstLiveSavingsDate,
  idlePeriodSavings,
  replaceHistorySavings,
} from "./savings";

const JOB_KEY = "junior:cache_warming:savings_refill:v1";
// Only one slice runs at a time. A slice that dies holds it for this long.
const SLICE_LOCK_KEY = "junior:cache_warming:savings_refill:v1:slice";
const SLICE_LOCK_TTL_MS = 5 * MINUTE_MS;
// Two start requests at once start one job.
const START_LOCK_KEY = "junior:cache_warming:savings_refill:v1:start";
const START_LOCK_TTL_MS = MINUTE_MS;
// Each slice that completes renews the lease. The heartbeat runs a slice each
// minute, so a job with no completed slice for this long has stopped.
const LEASE_MS = 10 * MINUTE_MS;
// A job that has not completed after this long fails, also with a lease.
const MAX_JOB_AGE_MS = 6 * 60 * MINUTE_MS;
// The last job stays readable for the System page this long.
const JOB_TTL_MS = 90 * 24 * 60 * MINUTE_MS;
// The longest range of the System page.
const REFILL_DAYS = 90;
const DAY_MS = 24 * 60 * MINUTE_MS;
// The heartbeat also runs the gap backfill, so a slice takes half its budget.
const SLICE_BUDGET_MS = BACKFILL_BUDGET_MS / 2;
const STOPPED_ERROR = "The re-fill stopped before it finished.";
const CANCELED_ERROR = "The history queries timed out.";

const refillJobSchema = z
  .object({
    id: z.string(),
    status: z.enum(["pending", "running", "done", "failed"]),
    startedAtMs: z.number(),
    finishedAtMs: z.number().optional(),
    error: z.string().optional(),
    leaseExpiresAtMs: z.number(),
    windowStartMs: z.number(),
    /** First day with live counters. The job writes only days before it. */
    liveStartDate: z.string(),
    afterConversationId: z.string().optional(),
    scannedConversations: z.number(),
    totalConversations: z.number(),
    /** Sums of the slices so far, per day and model. */
    sums: z.record(
      z.string(),
      z.record(z.string(), z.record(z.string(), z.number())),
    ),
  })
  .strict();

type RefillJob = z.output<typeof refillJobSchema>;

/** State of the last savings re-fill, for the System page. */
export interface SavingsRefillStatus {
  status: "idle" | "pending" | "running" | "done" | "failed";
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  scannedConversations?: number;
  totalConversations?: number;
}

const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const isoTime = (ms: number | undefined) =>
  ms === undefined ? undefined : new Date(ms).toISOString();

const isActive = (job: RefillJob) =>
  job.status === "pending" || job.status === "running";

const isStopped = (job: RefillJob, nowMs: number) =>
  isActive(job) &&
  (job.leaseExpiresAtMs <= nowMs || nowMs - job.startedAtMs > MAX_JOB_AGE_MS);

async function readJob(): Promise<RefillJob | undefined> {
  const state = await connectedState();
  const stored = await state.get(JOB_KEY);
  return stored === null ? undefined : refillJobSchema.parse(stored);
}

function toStatus(job: RefillJob | undefined, nowMs: number) {
  if (!job) return { status: "idle" } satisfies SavingsRefillStatus;
  const stopped = isStopped(job, nowMs);
  return {
    status: stopped ? "failed" : job.status,
    startedAt: isoTime(job.startedAtMs),
    finishedAt: isoTime(job.finishedAtMs),
    error: stopped ? (job.error ?? STOPPED_ERROR) : job.error,
    scannedConversations: job.scannedConversations,
    totalConversations: job.totalConversations,
  } satisfies SavingsRefillStatus;
}

/** Read the state of the last savings re-fill. */
export async function readSavingsRefill(
  nowMs = Date.now(),
): Promise<SavingsRefillStatus> {
  return toStatus(await readJob(), nowMs);
}

/**
 * Start a savings re-fill. Return `started: false` and the current state
 * when a job is still pending or running.
 */
export async function startSavingsRefill(
  nowMs = Date.now(),
): Promise<{ started: boolean; refill: SavingsRefillStatus }> {
  const state = await connectedState();
  if (!(await state.setIfNotExists(START_LOCK_KEY, true, START_LOCK_TTL_MS))) {
    return { started: false, refill: await readSavingsRefill(nowMs) };
  }
  try {
    const current = await readJob();
    if (current && isActive(current) && !isStopped(current, nowMs)) {
      return { started: false, refill: toStatus(current, nowMs) };
    }
    const windowStartMs = Date.parse(utcDate(nowMs - REFILL_DAYS * DAY_MS));
    const job: RefillJob = {
      id: randomUUID(),
      status: "pending",
      startedAtMs: nowMs,
      leaseExpiresAtMs: nowMs + LEASE_MS,
      windowStartMs,
      liveStartDate: (await firstLiveSavingsDate()) ?? utcDate(nowMs),
      scannedConversations: 0,
      totalConversations: await countHistoryConversations(windowStartMs),
      sums: {},
    };
    await state.set(JOB_KEY, job, JOB_TTL_MS);
    logInfo("cache_warming.savings_refill.started", {
      "app.cache_warming.backfill.conversation_count": job.totalConversations,
    });
    return { started: true, refill: toStatus(job, nowMs) };
  } finally {
    await state.delete(START_LOCK_KEY);
  }
}

// Count the period as live recording would when the stored call ended it. It
// prices the period with the model of that call, as live recording prices it
// with the model of the next request. A model that the gateway does not know
// has no prices, so its periods do not count. An idle period with a next
// call has the fields of a tool wait.
function addPeriod(job: RefillJob, period: ReplayedToolWait): void {
  const modelId = period.next.modelId;
  if (!modelId) return;
  const ttlMs = providerCacheTtlMs(modelId);
  if (ttlMs === undefined) return;
  let cost: { cacheRead: number; cacheWrite: number };
  try {
    cost = resolveGatewayModel(modelId).cost;
  } catch {
    return;
  }
  const savings = idlePeriodSavings({
    cacheTtlMs: ttlMs,
    gapMs: period.gapMs,
    prefixTokens: period.prefixTokens,
    cacheRead: period.next.cacheRead,
    cacheWrite: period.next.cacheWrite,
    cacheReadPrice: cost.cacheRead,
    cacheWritePrice: cost.cacheWrite,
  });
  if (savings) {
    addHistoryPeriod(job.sums, period.sinceMs + period.gapMs, modelId, savings);
  }
}

/**
 * Run the next slice of a pending or running savings re-fill. The heartbeat
 * calls it each minute. With no job to run, it makes one state request.
 */
export async function runSavingsRefillSlice(args: {
  nowMs: number;
  budgetMs?: number;
}): Promise<void> {
  const { nowMs } = args;
  const job = await readJob();
  if (!job || !isActive(job)) return;
  const state = await connectedState();
  // A stopped job reads as failed, and stays as it is until an admin starts
  // a new one. A write here could replace a job that started since the read.
  if (isStopped(job, nowMs)) return;
  if (
    !(await state.setIfNotExists(SLICE_LOCK_KEY, job.id, SLICE_LOCK_TTL_MS))
  ) {
    return;
  }
  try {
    await withSpan(
      "cache_warming.savings_refill.slice",
      "cache_warming.backfill",
      {},
      async (setSpanAttributes) => {
        const range = {
          start: utcDate(job.windowStartMs),
          end: job.liveStartDate,
        };
        // Live recording started before the window: no day to fill.
        const scan =
          range.start < range.end
            ? await scanIdlePeriodSlice({
                windowStartMs: job.windowStartMs,
                nowMs,
                budgetMs: args.budgetMs ?? SLICE_BUDGET_MS,
                afterConversationId: job.afterConversationId,
              })
            : undefined;
        for (const period of scan?.periods ?? []) {
          if (period.next) addPeriod(job, { ...period, next: period.next });
        }
        for (const toolWait of scan?.toolWaits ?? []) addPeriod(job, toolWait);
        // An admin started a new job after this one stopped.
        if ((await readJob())?.id !== job.id) return;
        const next: RefillJob = {
          ...job,
          status: "running",
          leaseExpiresAtMs: nowMs + LEASE_MS,
          afterConversationId:
            scan?.lastConversationId ?? job.afterConversationId,
          scannedConversations: job.scannedConversations + (scan?.scanned ?? 0),
        };
        delete next.error;
        const complete = scan?.complete ?? true;
        // Like the gap backfill, the scan skips a batch whose query timed out,
        // so one slow batch cannot stall the job. When every batch timed out,
        // the job read no history and must not replace the days with nothing.
        if (
          complete &&
          next.scannedConversations === 0 &&
          job.totalConversations > 0
        ) {
          Object.assign(next, {
            status: "failed",
            finishedAtMs: nowMs,
            error: CANCELED_ERROR,
            sums: {},
          } satisfies Partial<RefillJob>);
        } else if (complete) {
          await replaceHistorySavings(job.sums, range);
          Object.assign(next, {
            status: "done",
            finishedAtMs: nowMs,
            sums: {},
          } satisfies Partial<RefillJob>);
        }
        await state.set(JOB_KEY, next, JOB_TTL_MS);
        const attributes = {
          "app.cache_warming.backfill.conversation_count": scan?.scanned ?? 0,
          "app.cache_warming.backfill.canceled_batch_count":
            scan?.canceledBatches ?? 0,
          "app.cache_warming.backfill.outcome": complete
            ? "completed"
            : "continued",
        };
        setSpanAttributes(attributes);
        if (complete) {
          logInfo("cache_warming.savings_refill.completed", attributes);
        }
      },
    );
  } catch (error) {
    // The job keeps running, and the next heartbeat tries the slice again.
    // The lease ends a job whose slices keep failing, with this error.
    const current = await readJob();
    if (current?.id === job.id) {
      await state.set(
        JOB_KEY,
        {
          ...current,
          error: error instanceof Error ? error.message : String(error),
        } satisfies RefillJob,
        JOB_TTL_MS,
      );
    }
    throw error;
  } finally {
    await state.delete(SLICE_LOCK_KEY);
  }
}
