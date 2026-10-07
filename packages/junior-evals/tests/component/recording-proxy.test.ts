import { createServer, type Server } from "node:http";
import { mkdtemp, readdir, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Agent, ProxyAgent, request } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  startRecordingProxy,
  type RecordingMode,
  type RecordingProxy,
} from "../../src/recording-proxy/recording-proxy";

let upstream: Server;
let origin: string;
let liveRequests: number;
let directory: string;
let proxy: RecordingProxy | undefined;
const control = new Agent();

async function start(mode: RecordingMode): Promise<RecordingProxy> {
  proxy = await startRecordingProxy({
    directory,
    rules: [
      {
        name: "model",
        mode,
        method: "POST",
        urlPrefix: `${origin}/v1/`,
        ignore: [String.raw`\d{4}-\d{2}-\d{2}T[\d:.]+Z`],
      },
    ],
  });
  return proxy;
}

/** Send one test session through the proxy, then commit or discard it. */
async function session(
  running: RecordingProxy,
  bodies: unknown[],
  end: "commit" | "discard" = "commit",
) {
  const id = `session-${Math.random()}`;
  const agent = new ProxyAgent({
    uri: running.url,
    token: `Basic ${Buffer.from(`${id}:${running.secret}`).toString("base64")}`,
  });
  const responses: Array<{ body: string; source: unknown }> = [];
  for (const body of bodies) {
    const response = await request(`${origin}/v1/messages`, {
      body: JSON.stringify(body),
      dispatcher: agent,
      method: "POST",
    });
    responses.push({
      body: await response.body.text(),
      source: response.headers["x-recording-proxy"],
    });
  }
  const counts = await request(
    `${running.url}/__recording-proxy/sessions/${id}`,
    { dispatcher: control, headers: auth(running) },
  );
  const result = { counts: await counts.body.json(), responses };
  await (
    await request(`${running.url}/__recording-proxy/sessions/${id}/${end}`, {
      dispatcher: control,
      headers: auth(running),
      method: "POST",
    })
  ).body.dump();
  await agent.close();
  return result;
}

function auth(running: RecordingProxy) {
  return { authorization: `Bearer ${running.secret}` };
}

async function files(): Promise<string[]> {
  return readdir(path.join(directory, "model")).catch(() => []);
}

beforeEach(async () => {
  liveRequests = 0;
  upstream = createServer((incoming, outgoing) => {
    liveRequests += 1;
    outgoing.writeHead(200, { "content-type": "text/event-stream" });
    outgoing.end(`data: ${liveRequests}\n\n`);
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("No port");
  origin = `http://127.0.0.1:${address.port}`;
  directory = await mkdtemp(path.join(tmpdir(), "recording-proxy-"));
});

afterEach(async () => {
  await proxy?.close();
  proxy = undefined;
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

describe("recording proxy", () => {
  it("replays a committed session for the same requests in auto mode", async () => {
    const running = await start("auto");
    await session(running, [
      { model: "m", messages: [{ content: "hi", at: "2026-10-07T03:18:03Z" }] },
    ]);

    // Same request with other key order and another clock time.
    const replay = await session(running, [
      {
        messages: [{ at: "2026-10-08T10:00:00.123Z", content: "hi" }],
        model: "m",
      },
      { model: "m", messages: ["changed"] },
    ]);

    expect(replay.responses).toEqual([
      { body: "data: 1\n\n", source: "replayed" },
      { body: "data: 2\n\n", source: "live" },
    ]);
    expect(replay.counts).toEqual({ model: { live: 1, replayed: 1 } });
    expect(liveRequests).toBe(2);
  });

  it("sends no request without the secret", async () => {
    const running = await start("auto");
    const agent = new ProxyAgent({
      uri: running.url,
      token: `Basic ${Buffer.from("session:wrong").toString("base64")}`,
    });

    await expect(
      request(`${origin}/v1/messages`, { dispatcher: agent, method: "POST" }),
    ).rejects.toThrow();
    const counts = await request(
      `${running.url}/__recording-proxy/sessions/x`,
      { dispatcher: control },
    );
    expect(counts.statusCode).toBe(401);
    await counts.body.dump();
    expect(liveRequests).toBe(0);
    await agent.close();
  });

  it("writes nothing for a discarded session", async () => {
    const running = await start("auto");
    await session(running, [{ model: "m" }], "discard");
    await session(running, [{ model: "m" }], "discard");

    expect(liveRequests).toBe(2);
    await expect(files()).resolves.toEqual([]);
  });

  it("writes a replayed recording again with the same content", async () => {
    const running = await start("auto");
    await session(running, [{ model: "m" }]);
    const [file] = await files();
    const recordingPath = path.join(directory, "model", file!);
    const content = await readFile(recordingPath, "utf8");
    const old = new Date("2026-01-01T00:00:00Z");
    await utimes(recordingPath, old, old);

    await session(running, [{ model: "m" }]);

    // The nightly workflow deletes recordings that a run did not write.
    expect((await stat(recordingPath)).mtimeMs).toBeGreaterThan(old.getTime());
    await expect(readFile(recordingPath, "utf8")).resolves.toBe(content);
    expect(liveRequests).toBe(1);
  });

  it("refreshes a recording in record mode", async () => {
    const running = await start("record");
    await session(running, [{ model: "m" }]);
    const second = await session(running, [{ model: "m" }]);

    expect(second.responses).toEqual([{ body: "data: 2\n\n", source: "live" }]);
    await expect(files()).resolves.toHaveLength(1);
  });
});
