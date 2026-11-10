import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { personReplyTimesReportSchema } from "@/api/schema";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { createAgent } from "../../../fixtures/agent";
import { closeConversationFixture } from "../../../fixtures/conversation";
import { mockTitleModel } from "../../../fixtures/title-model";

const MINUTE = 60_000;
const T0 = Date.parse("2026-06-01T09:00:00.000Z");

function reply(startedAtMs: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Done." }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 10,
      output: 10,
      cacheRead: 60_000,
      cacheWrite: 0,
      totalTokens: 60_020,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: startedAtMs,
  };
}

// Alice, the web test Actor, runs one Turn at each time.
async function runTurns(times: number[]) {
  const modelStream: StreamFn = () => {
    const stream = createAssistantMessageEventStream();
    const message = reply(Date.now());
    queueMicrotask(() => {
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
    });
    return stream;
  };
  const agent = await createAgent({
    modelStream,
    botConfig: { modelId: "openai/gpt-5.5" },
  });
  for (const [index, atMs] of times.entries()) {
    vi.setSystemTime(atMs);
    await agent.run(`Question ${index + 1}`);
  }
}

async function replyTimes(viewerEmail: string) {
  const viewer = await resolveViewerUser(viewerEmail);
  if (!viewer) throw new Error(`missing viewer for ${viewerEmail}`);
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  return await app.request(
    "http://localhost/api/people/alice%40example.com/reply-times?days=1",
  );
}

describe("person reply times API", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await closeConversationFixture();
  });

  it("serves the reply times of a person only to that person", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    mockTitleModel("Conversation title");
    // Alice replies after 7 minutes, then after 60 minutes, which is past
    // the horizon. Nobody replies to the last Turn.
    await runTurns([T0, T0 + 7 * MINUTE, T0 + 67 * MINUTE]);
    vi.setSystemTime(T0 + 130 * MINUTE);

    const own = await replyTimes("alice@example.com");
    expect(own.status).toBe(200);
    const report = personReplyTimesReportSchema.parse(await own.json());
    expect(report.histogram).toMatchObject({ noReply: 1, total: 2 });
    // The 7 min reply follows the first Turn, the late one the second.
    expect(
      report.depths.map(({ depth, histogram }) => ({
        depth,
        noReply: histogram.noReply,
        total: histogram.total,
      })),
    ).toEqual([
      { depth: "1", noReply: 0, total: 1 },
      { depth: "2-3", noReply: 1, total: 1 },
      { depth: "4+", noReply: 0, total: 0 },
    ]);
    expect(report.histogram.bins.filter((bin) => bin.count > 0)).toEqual([
      { startMs: 7 * MINUTE, endMs: 10 * MINUTE, count: 1 },
    ]);

    const other = await replyTimes("bob@example.com");
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual({ error: "Reply times not found." });
  });
});
