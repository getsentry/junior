import { Hono } from "hono";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import {
  VERSIONS_STREAM_HEADER,
  VERSIONS_STREAM_KEEPALIVE_EVENT,
  versionsSchema,
} from "@/api/schema";
import { closeDb, getSqlExecutor } from "@/chat/db";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { recordRoot } from "../../fixtures/dashboard-reporting";

// Chat config reads the flag when it loads, so set it first.
const { previous } = vi.hoisted(() => {
  const previous = process.env["JUNIOR_VERSIONS_STREAM_ENABLED"];
  process.env["JUNIOR_VERSIONS_STREAM_ENABLED"] = "true";
  return { previous };
});

afterAll(() => {
  if (previous === undefined) {
    delete process.env["JUNIOR_VERSIONS_STREAM_ENABLED"];
  } else {
    process.env["JUNIOR_VERSIONS_STREAM_ENABLED"] = previous;
  }
});

const OWN = "slack:CVERSIONSTREAM:own";
const SLACK_ACTOR = {
  email: "ana@example.com",
  slackUserId: "UANA",
  teamId: "TREPORTING",
};

async function authenticatedApi() {
  const viewer = await resolveViewerUser(SLACK_ACTOR.email);
  if (!viewer) throw new Error("missing viewer");
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  return app;
}

type Api = Awaited<ReturnType<typeof authenticatedApi>>;

/** Read SSE events from one stream response, one at a time. */
async function openStream(app: Api, conversationIds: string[] = []) {
  const response = await app.request(
    `http://localhost/api/versions/stream?${new URLSearchParams({ conversationIds: conversationIds.join(",") })}`,
  );
  if (!response.body) throw new Error("The stream has no body");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  const nextEvent = async (): Promise<{ data: string; event: string }> => {
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end >= 0) {
        const lines = buffer.slice(0, end).split("\n");
        buffer = buffer.slice(end + 2);
        const field = (name: string) =>
          lines
            .find((line) => line.startsWith(`${name}: `))
            ?.slice(name.length + 2);
        const data = field("data");
        // The `retry:` block carries no event.
        if (data !== undefined) {
          return { data, event: field("event") ?? "message" };
        }
        continue;
      }
      const chunk = await reader.read();
      if (chunk.done) return { data: "", event: "end" };
      buffer += chunk.value;
    }
  };
  return {
    response,
    cancel: () => reader.cancel(),
    /** The next tokens. Keepalives in between are skipped. */
    async next() {
      for (;;) {
        const event = await nextEvent();
        if (event.event === VERSIONS_STREAM_KEEPALIVE_EVENT) continue;
        if (event.event === "end") return "end" as const;
        return versionsSchema.parse(JSON.parse(event.data));
      }
    },
  };
}

async function poll(app: Api, conversationIds: string[] = []) {
  const response = await app.request(
    `http://localhost/api/versions?${new URLSearchParams({ conversationIds: conversationIds.join(",") })}`,
  );
  return {
    header: response.headers.get(VERSIONS_STREAM_HEADER),
    versions: versionsSchema.parse(await response.json()),
  };
}

/** The `LISTEN` sessions on this test's database. */
async function listenSessions() {
  return await getSqlExecutor().query<{ pid: number }>(
    `SELECT pid FROM pg_stat_activity
     WHERE application_name = 'junior-versions-listen'
       AND datname = current_database()`,
  );
}

async function pin(app: Api) {
  const response = await app.request(
    `http://localhost/api/conversations/${OWN}/pin`,
    {
      body: JSON.stringify({ pinned: true }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    },
  );
  expect(response.status).toBe(200);
}

describe("versions stream", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("pushes the tokens that a write moves, over one shared session", async () => {
    const app = await authenticatedApi();
    await recordRoot(OWN, "private", SLACK_ACTOR);
    const before = await poll(app, [OWN]);
    expect(before.header).toBe("1");

    const own = await openStream(app, [OWN]);
    expect(own.response.headers.get("content-type")).toBe("text/event-stream");
    // The first message is the baseline, the same tokens as the poll.
    expect(await own.next()).toEqual(before.versions);
    const feed = await openStream(app);
    expect(await feed.next()).toEqual((await poll(app)).versions);
    expect(await listenSessions()).toHaveLength(1);

    // A pin moves the feed and the detail token. Each stream reads again
    // and pushes what the poll now reads, at most once each 5 s.
    await pin(app);
    const after = await poll(app, [OWN]);
    expect(after.versions.conversations).not.toBe(
      before.versions.conversations,
    );
    expect(await own.next()).toEqual(after.versions);
    expect((await feed.next()) as object).toMatchObject({
      conversations: after.versions.conversations,
    });

    // The session stays while one stream is open, and closes with the last.
    await own.cancel();
    expect(await listenSessions()).toHaveLength(1);
    await feed.cancel();
    await expect.poll(listenSessions).toHaveLength(0);
  }, 20_000);

  it("ends every stream when the session is lost, and a new stream reads again", async () => {
    const app = await authenticatedApi();
    await recordRoot(OWN, "private", SLACK_ACTOR);
    const stream = await openStream(app, [OWN]);
    const baseline = await stream.next();
    const [lost] = await listenSessions();

    await getSqlExecutor().query("SELECT pg_terminate_backend($1)", [
      lost!.pid,
    ]);
    // A `NOTIFY` sent while no session listens is lost, so the stream ends,
    // and the client's next stream starts from a fresh read.
    expect(await stream.next()).toBe("end");

    await pin(app);
    const reopened = await openStream(app, [OWN]);
    const fresh = await reopened.next();
    expect(fresh).not.toEqual(baseline);
    expect(fresh).toEqual((await poll(app, [OWN])).versions);
    const [session] = await listenSessions();
    expect(session?.pid).not.toBe(lost!.pid);
    await reopened.cancel();
  }, 20_000);
});
