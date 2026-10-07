import { createServer, type Server } from "node:http";
import { mkdtemp, readdir, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { USER_AGENT } from "@/chat/tools/web/constants";
import { createRecordings, recordingKey } from "../../src/fixture/recordings";

const PAGE = "<html>page</html>";

let server: Server;
let origin: string;
let liveRequests: number;
let directory: string;

/** A request that the `web` rule matches. */
function pageRequest(pathname = "/page"): Request {
  return new Request(`${origin}${pathname}`, {
    headers: { "user-agent": USER_AGENT },
  });
}

function modelRequest(body: unknown): Request {
  return new Request("https://ai-gateway.vercel.sh/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function webFiles(): Promise<string[]> {
  return readdir(path.join(directory, "web")).catch(() => []);
}

beforeEach(async () => {
  liveRequests = 0;
  server = createServer((request, response) => {
    liveRequests += 1;
    if (request.url === "/old") {
      response.writeHead(301, { location: "/page" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  origin = `http://127.0.0.1:${address.port}`;
  directory = await mkdtemp(path.join(tmpdir(), "recordings-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

describe("recordings", () => {
  it("replays a saved response for the same request in auto mode", async () => {
    vi.stubEnv("VITEST_EVALS_REPLAY_MODE", "auto");
    const recorded = createRecordings(directory);
    await recorded.fetch(pageRequest());
    // A redirect is its own recording and is not followed.
    expect((await recorded.fetch(pageRequest("/old"))).status).toBe(301);
    await recorded.save();

    const replay = createRecordings(directory);
    const page = await replay.fetch(pageRequest());
    const redirect = await replay.fetch(pageRequest("/old"));

    expect(await page.text()).toBe(PAGE);
    expect(page.headers.get("content-type")).toBe("text/html");
    expect(redirect.headers.get("location")).toBe("/page");
    expect(liveRequests).toBe(2);
    expect(replay.counts().web).toEqual({ live: 0, replayed: 2 });
  });

  it("ignores key order and ISO times in the key", async () => {
    const key = (body: unknown) => recordingKey("model", modelRequest(body));
    const first = await key({
      model: "m",
      messages: [{ role: "user", content: "hi", at: "2026-10-07T03:18:03Z" }],
    });

    await expect(
      key({
        messages: [
          { at: "2026-10-08T10:00:00.123Z", content: "hi", role: "user" },
        ],
        model: "m",
      }),
    ).resolves.toBe(first);
    await expect(key({ model: "m", messages: ["changed"] })).resolves.not.toBe(
      first,
    );
  });

  it("writes nothing until the test saves", async () => {
    vi.stubEnv("VITEST_EVALS_REPLAY_MODE", "auto");
    await createRecordings(directory).fetch(pageRequest());
    await createRecordings(directory).fetch(pageRequest());

    expect(liveRequests).toBe(2);
    await expect(webFiles()).resolves.toEqual([]);
  });

  it("writes a replayed recording again with the same content", async () => {
    vi.stubEnv("VITEST_EVALS_REPLAY_MODE", "auto");
    const recorded = createRecordings(directory);
    await recorded.fetch(pageRequest());
    await recorded.save();
    const [file] = await webFiles();
    const recordingPath = path.join(directory, "web", file!);
    const content = await readFile(recordingPath, "utf8");
    const old = new Date("2026-01-01T00:00:00Z");
    await utimes(recordingPath, old, old);

    const replay = createRecordings(directory);
    await replay.fetch(pageRequest());
    await replay.save();

    // The nightly workflow deletes recordings that a run did not write.
    expect((await stat(recordingPath)).mtimeMs).toBeGreaterThan(old.getTime());
    await expect(readFile(recordingPath, "utf8")).resolves.toBe(content);
    expect(liveRequests).toBe(1);
  });

  it("refreshes a recording in record mode", async () => {
    vi.stubEnv("VITEST_EVALS_REPLAY_MODE", "record");
    for (let run = 0; run < 2; run += 1) {
      const recordings = createRecordings(directory);
      await recordings.fetch(pageRequest());
      await recordings.save();
    }

    expect(liveRequests).toBe(2);
    await expect(webFiles()).resolves.toHaveLength(1);
  });
});
