import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mswServer } from "../../msw/server";
import { getConversationStore, getDb } from "@/chat/db";
import {
  recordSandboxSession,
  runSandboxCostSweep,
  stopSandboxSession,
} from "@/chat/sandbox/cost";
import { getSandboxProvider } from "@/chat/sandbox/provider";
import { estimateSessionCostUsd } from "@/chat/sandbox/vercel/pricing";
import { readConversationStatsFromSql } from "@/api/conversations/stats.query";
import { readConversationTreeMetricsFromSql } from "@/api/conversations/usage";
import { juniorConversations, juniorSandboxSessions } from "@/db/schema";
import { inboundMessage } from "../../fixtures/conversation-work";

/** One session record, in the shape the Vercel Sandbox API returns it. */
interface FakeSession {
  id: string;
  status: "running" | "stopped";
  memory: number;
  vcpus: number;
  region: string;
  timeout: number;
  cwd: string;
  requestedAt: number;
  createdAt: number;
  updatedAt: number;
  duration?: number;
  activeCpuDurationMs?: number;
}

const VERCEL_API = "https://api.vercel.com";

/**
 * Fake Vercel Sandbox API. The real SDK and Junior's provider adapter call it
 * through `globalThis.fetch`, so this also proves they never use the SDK's own
 * `fetch`.
 */
function useFakeVercelSandboxApi() {
  const sandboxes = new Map<string, FakeSession[]>();
  const gets: Array<{ name: string; resume: string | null }> = [];
  const sandboxBody = (name: string) => {
    const session = sandboxes.get(name)!.at(-1)!;
    return {
      sandbox: {
        name,
        persistent: false,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        currentSessionId: session.id,
        status: session.status,
      },
      session,
      routes: [],
    };
  };
  const create = async ({ request }: { request: Request }) => {
    const { name } = (await request.json()) as { name: string };
    const now = Date.now();
    sandboxes.set(name, [
      {
        id: `${name}-session-1`,
        status: "running",
        memory: 4096,
        vcpus: 2,
        region: "iad1",
        timeout: 30 * 60_000,
        cwd: "/vercel/sandbox",
        requestedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    return HttpResponse.json(sandboxBody(name));
  };
  mswServer.use(
    http.post(`${VERCEL_API}/v2/sandboxes`, create),
    http.post(`${VERCEL_API}/v3/sandboxes`, create),
    http.get(`${VERCEL_API}/v2/sandboxes/sessions`, ({ request }) => {
      const name = new URL(request.url).searchParams.get("name")!;
      const sessions = [...(sandboxes.get(name) ?? [])].reverse();
      return HttpResponse.json({
        sessions,
        pagination: { count: sessions.length, next: null },
      });
    }),
    http.post(
      `${VERCEL_API}/v2/sandboxes/sessions/:sessionId/stop`,
      ({ params }) => {
        const session = [...sandboxes.values()]
          .flat()
          .find((candidate) => candidate.id === params.sessionId)!;
        Object.assign(session, {
          status: "stopped",
          duration: 4 * 60_000,
          activeCpuDurationMs: 30_000,
        });
        return HttpResponse.json({ session });
      },
    ),
    http.get(`${VERCEL_API}/v2/sandboxes/:name`, ({ params, request }) => {
      const name = String(params.name);
      gets.push({
        name,
        resume: new URL(request.url).searchParams.get("resume"),
      });
      if (!sandboxes.has(name)) {
        return HttpResponse.json(
          { error: { code: "not_found", message: "Sandbox not found" } },
          { status: 404 },
        );
      }
      return HttpResponse.json(sandboxBody(name));
    }),
  );
  return { sandboxes, gets };
}

const CONVERSATION_ID = "slack:C123:1718123456.000000";
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

async function conversationSandboxCost() {
  const [row] = await getDb()
    .select({ value: juniorConversations.sandboxCostUsd })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, CONVERSATION_ID));
  return row?.value ?? undefined;
}

async function createSession(name: string) {
  return await getSandboxProvider().createSession({
    name,
    persistent: false,
    timeoutMs: 30 * MINUTE_MS,
  });
}

describe("Sandbox cost estimate", () => {
  let vercel: ReturnType<typeof useFakeVercelSandboxApi>;

  beforeEach(async () => {
    vi.stubEnv("VERCEL_TOKEN", "vercel-test-token");
    vi.stubEnv("VERCEL_TEAM_ID", "team_test");
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_test");
    vercel = useFakeVercelSandboxApi();
    await getConversationStore().recordActivity({
      conversationId: CONVERSATION_ID,
      destination: inboundMessage("sandbox-cost").destination,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("adds a session's cost to its Conversation after the sandbox times out", async () => {
    const startMs = Date.now();
    const session = await createSession("junior-timeout");
    await recordSandboxSession({
      conversationId: CONVERSATION_ID,
      session,
      createdSandbox: true,
      nowMs: startMs,
    });

    // The session is still running, so the sweep waits for it.
    await runSandboxCostSweep({ nowMs: startMs + 15 * MINUTE_MS });
    expect(await conversationSandboxCost()).toBeUndefined();

    // Injected fault: the Sandbox timed out after the Turn. No Junior code
    // stops it, so only Vercel's session record holds the usage.
    Object.assign(vercel.sandboxes.get("junior-timeout")![0]!, {
      status: "stopped",
      duration: 31 * MINUTE_MS,
      activeCpuDurationMs: 90_000,
    });
    await runSandboxCostSweep({ nowMs: startMs + 40 * MINUTE_MS });

    const expected = estimateSessionCostUsd({
      activeCpuMs: 90_000,
      memoryMb: 4096,
      durationMs: 31 * MINUTE_MS,
      createdSandbox: true,
    });
    expect(await conversationSandboxCost()).toBeCloseTo(expected, 12);
    // The sweep reads the stopped Sandbox without resuming it.
    expect(vercel.gets).toEqual([
      { name: "junior-timeout", resume: "false" },
      { name: "junior-timeout", resume: "false" },
    ]);

    // The Run's summary write lands later and keeps the Sandbox cost.
    await getConversationStore().recordExecution({
      conversationId: CONVERSATION_ID,
      createdAtMs: startMs,
      execution: {
        runId: "conversation-run:1",
        status: "idle",
        updatedAtMs: startMs,
      },
      lastActivityAtMs: startMs,
      metrics: { durationMs: 5_000, usage: { cost: { total: 0.25 } } },
      updatedAtMs: startMs,
    });
    expect(await conversationSandboxCost()).toBeCloseTo(expected, 12);
    const tree = await readConversationTreeMetricsFromSql(getDb(), [
      CONVERSATION_ID,
    ]);
    expect(tree.get(CONVERSATION_ID)).toMatchObject({
      sandboxCostUsd: expect.closeTo(expected, 12),
      usage: { cost: { total: 0.25 } },
    });
    // System stats read the session rows.
    const stats = await readConversationStatsFromSql();
    const statsSandboxCost = stats.metricDays.reduce(
      (total, day) => total + (day.sandboxCostUsd ?? 0),
      0,
    );
    expect(statsSandboxCost).toBeCloseTo(expected, 6);
  });

  it("writes the cost when Junior stops a session and gives up on gone sandboxes", async () => {
    const nowMs = Date.now();
    const replaced = await createSession("junior-replaced");
    await recordSandboxSession({
      conversationId: CONVERSATION_ID,
      session: replaced,
      createdSandbox: true,
      nowMs,
    });
    await stopSandboxSession(replaced);
    const stoppedCost = estimateSessionCostUsd({
      activeCpuMs: 30_000,
      memoryMb: 4096,
      durationMs: 4 * MINUTE_MS,
      createdSandbox: true,
    });
    expect(await conversationSandboxCost()).toBeCloseTo(stoppedCost, 12);

    // Injected fault: Vercel already removed this Sandbox and its records.
    await recordSandboxSession({
      conversationId: CONVERSATION_ID,
      session: { sandboxId: "junior-removed", sessionId: "removed-session" },
      createdSandbox: false,
      nowMs,
    });
    // Too old to read: settled without a provider call.
    await recordSandboxSession({
      conversationId: CONVERSATION_ID,
      session: { sandboxId: "junior-old", sessionId: "old-session" },
      createdSandbox: false,
      nowMs: nowMs - 15 * DAY_MS,
    });
    await runSandboxCostSweep({ nowMs: nowMs + 15 * MINUTE_MS });

    expect(vercel.gets).toEqual([{ name: "junior-removed", resume: "false" }]);
    // Every record is settled, so no later sweep reads them again.
    const records = await getDb()
      .select({
        sessionId: juniorSandboxSessions.sessionId,
        settledAt: juniorSandboxSessions.settledAt,
      })
      .from(juniorSandboxSessions)
      .orderBy(juniorSandboxSessions.sessionId);
    expect(
      records.map((row) => [row.sessionId, row.settledAt !== null]),
    ).toEqual([
      ["junior-replaced-session-1", true],
      ["old-session", true],
      ["removed-session", true],
    ]);
    // Sessions without a cost leave the Conversation total alone.
    expect(await conversationSandboxCost()).toBeCloseTo(stoppedCost, 12);
  });
});
