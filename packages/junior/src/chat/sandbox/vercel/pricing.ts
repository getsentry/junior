import type { SandboxSessionCost } from "@/chat/sandbox/workspace";

// Pro plan list rates for the default `iad1` region, from
// https://vercel.com/docs/vercel-sandbox/pricing (read 2026-11). Data
// transfer is left out: Pro includes it in the flat-rate CDN.
const ACTIVE_CPU_USD_PER_HOUR = 0.128;
const MEMORY_USD_PER_GB_HOUR = 0.0212;
const CREATION_USD = 0.6 / 1_000_000;
/** Vercel bills provisioned memory in 1-minute minimum increments. */
const MIN_MEMORY_BILLED_MS = 60_000;
const HOUR_MS = 60 * 60 * 1000;
const MB_PER_GB = 1024;

/** Usage fields of one Vercel session record. */
interface VercelSessionUsage {
  status: string;
  /** Provisioned memory in MB. */
  memory: number;
  /** Wall-clock duration in milliseconds. */
  duration?: number;
  /** CPU time across all vCPUs in milliseconds. */
  activeCpuDurationMs?: number;
}

/** Estimate the list-price cost of one VM session in USD. */
export function estimateSessionCostUsd(usage: {
  activeCpuMs: number;
  memoryMb: number;
  durationMs: number;
  createdSandbox: boolean;
}): number {
  const cpu = (usage.activeCpuMs / HOUR_MS) * ACTIVE_CPU_USD_PER_HOUR;
  const memory =
    (usage.memoryMb / MB_PER_GB) *
    (Math.max(usage.durationMs, MIN_MEMORY_BILLED_MS) / HOUR_MS) *
    MEMORY_USD_PER_GB_HOUR;
  return cpu + memory + (usage.createdSandbox ? CREATION_USD : 0);
}

/**
 * Turn a session record into a cost. Vercel reports usage only once the VM
 * is stopped, so a live session is `pending`.
 */
export function sessionCost(
  session: VercelSessionUsage,
  createdSandbox: boolean,
): SandboxSessionCost {
  const { activeCpuDurationMs, duration, status } = session;
  if (status !== "stopped" && status !== "failed" && status !== "aborted") {
    return { status: "pending" };
  }
  if (activeCpuDurationMs === undefined || duration === undefined) {
    // A stopped session can report its usage a little later. A failed or
    // aborted session without usage never reports it.
    return status === "stopped" ? { status: "pending" } : { status: "missing" };
  }
  return {
    status: "ready",
    costUsd: estimateSessionCostUsd({
      activeCpuMs: activeCpuDurationMs,
      memoryMb: session.memory,
      durationMs: duration,
      createdSandbox,
    }),
  };
}
