import { afterEach, beforeEach, inject } from "vitest";
import "./eval-context";

const context = inject("juniorEvalContext");
if (!context) {
  throw new Error("Eval global setup did not provide invocation context");
}
const evalContext = context;
process.env.JUNIOR_BASE_URL = evalContext.baseUrl;
process.env.JUNIOR_STATE_ADAPTER = "redis";
process.env.JUNIOR_STATE_KEY_PREFIX = evalContext.stateKeyPrefix;
process.env.REDIS_URL = evalContext.redisUrl;

/** Read fixture observations owned by the invocation-wide egress process. */
export async function readEvalEgressFixtureState<T>(): Promise<T> {
  const response = await fetch(evalContext.stateUrl, {
    headers: { authorization: `Bearer ${evalContext.controlToken}` },
  });
  if (!response.ok) {
    throw new Error(
      `Eval egress fixture read failed with HTTP ${response.status}`,
    );
  }
  return (await response.json()) as T;
}

beforeEach(async () => {
  const response = await fetch(evalContext.controlUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${evalContext.controlToken}` },
  });
  if (!response.ok) {
    throw new Error(
      `Eval egress fixture reset failed with HTTP ${response.status}`,
    );
  }
});

afterEach(async () => {
  // Keep stateful runtime modules behind the invocation-provided Redis env.
  const { drainPendingEvalPluginJobs } = await import("./behavior-harness");
  await drainPendingEvalPluginJobs();
  const { closeDb } = await import("@/chat/db");
  await closeDb();
});
