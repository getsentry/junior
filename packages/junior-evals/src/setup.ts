import { afterEach, beforeEach, inject } from "vitest";
import { closeDb } from "@/chat/db";
import { drainPendingEvalPluginTasks } from "./behavior-harness";
import "./eval-context";

const egress = inject("juniorEvalEgress");
if (!egress) {
  throw new Error("Eval global setup did not provide public egress");
}
const evalEgress = egress;
process.env.JUNIOR_BASE_URL = evalEgress.baseUrl;

/** Read fixture observations owned by the invocation-wide egress process. */
export async function readEvalEgressFixtureState<T>(): Promise<T> {
  const response = await fetch(evalEgress.stateUrl, {
    headers: { authorization: `Bearer ${evalEgress.controlToken}` },
  });
  if (!response.ok) {
    throw new Error(
      `Eval egress fixture read failed with HTTP ${response.status}`,
    );
  }
  return (await response.json()) as T;
}

beforeEach(async () => {
  const response = await fetch(evalEgress.controlUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${evalEgress.controlToken}` },
  });
  if (!response.ok) {
    throw new Error(
      `Eval egress fixture reset failed with HTTP ${response.status}`,
    );
  }
});

afterEach(async () => {
  await drainPendingEvalPluginTasks();
  await closeDb();
});
