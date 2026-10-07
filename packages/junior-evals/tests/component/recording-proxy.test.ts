import { createServer, type Server } from "node:http";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProxyAgent, request } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectRecordingProxy } from "../../src/recording-proxy/client";
import {
  startRecordingProxy,
  type RecordingMode,
  type RecordingProxyServer,
} from "../../src/recording-proxy/recording-proxy";
import { pruneRecordings } from "../../src/recording-proxy/recordings";

let upstream: Server;
let origin: string;
let liveRequests: number;
let directory: string;
let proxy: RecordingProxyServer | undefined;
let agent: ProxyAgent | undefined;

async function start(
  mode: RecordingMode,
  usedFile?: string,
): Promise<RecordingProxyServer> {
  proxy = await startRecordingProxy({
    directory,
    mode,
    allow: [origin],
    rules: [
      {
        name: "model",
        match: { method: "POST", url: `${origin}/v1/` },
        key: { ignore: [String.raw`\d{4}-\d{2}-\d{2}T[\d:.]+Z`] },
      },
    ],
    usedFile,
  });
  agent = new ProxyAgent({ uri: proxy.url });
  return proxy;
}

/** Send requests through the proxy. */
async function send(bodies: unknown[], target = `${origin}/v1/messages`) {
  const responses: Array<{ body: string; source: unknown }> = [];
  for (const body of bodies) {
    const response = await request(target, {
      body: JSON.stringify(body),
      dispatcher: agent,
      method: "POST",
    });
    responses.push({
      body: await response.body.text(),
      source: response.headers["x-recording-proxy"],
    });
  }
  return responses;
}

/** Send the requests of one test session, then end it. */
async function session(
  running: RecordingProxyServer,
  bodies: unknown[],
  passed = true,
) {
  const control = connectRecordingProxy(running);
  await control.startSession("test");
  const responses = await send(bodies);
  const { missed } = await control.endSession(passed);
  return Object.assign(responses, { missed });
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
  await agent?.close();
  agent = undefined;
  await proxy?.close();
  proxy = undefined;
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

describe("recording proxy", () => {
  it("replays a passed session for the same requests in auto mode", async () => {
    const running = await start("auto");
    await session(running, [
      { model: "m", messages: [{ content: "hi", at: "2026-10-07T03:18:03Z" }] },
    ]);
    const [first] = await files();

    // Same request with other key order and another clock time.
    const replay = await session(running, [
      {
        messages: [{ at: "2026-10-08T10:00:00.123Z", content: "hi" }],
        model: "m",
      },
      { model: "m", messages: ["changed"] },
    ]);

    expect([...replay]).toEqual([
      { body: "data: 1\n\n", source: "replayed" },
      { body: "data: 2\n\n", source: "live" },
    ]);
    expect(liveRequests).toBe(2);
    await expect(connectRecordingProxy(running).stats()).resolves.toEqual({
      counts: { model: { live: 2, missed: 0, replayed: 1 } },
      // The miss names the closest recording of the test and the part
      // of the request that differs from it.
      misses: [
        expect.objectContaining({ session: "test" }),
        {
          rule: "model",
          session: "test",
          file: expect.stringMatching(/^model\/[0-9a-f]{64}\.json$/),
          closest: `model/${first}`,
          differs: ["messages[0]"],
        },
      ],
      written: 2,
      discarded: 0,
      passthrough: {},
    });
  });

  it("fails a request without a recording in replay mode and sends nothing", async () => {
    const recording = await start("auto");
    await session(recording, [{ model: "m" }]);
    await recording.close();
    const recorded = await files();

    const running = await start("replay");
    const replay = await session(running, [{ model: "m" }, { model: "other" }]);

    expect([...replay]).toEqual([
      { body: "data: 1\n\n", source: "replayed" },
      {
        body: expect.stringContaining("no model recording"),
        source: "missed",
      },
    ]);
    expect(replay.missed).toBe(1);
    expect(liveRequests).toBe(1);
    await expect(files()).resolves.toEqual(recorded);
    await expect(connectRecordingProxy(running).stats()).resolves.toMatchObject(
      {
        counts: { model: { live: 0, missed: 1, replayed: 1 } },
        misses: [{ closest: `model/${recorded[0]}`, differs: ["model"] }],
      },
    );
  });

  it("sends no request to another origin", async () => {
    await start("auto");

    // The same server under another name is another origin.
    await expect(
      send([{}], `${origin.replace("127.0.0.1", "localhost")}/v1/messages`),
    ).rejects.toThrow("403");
    expect(liveRequests).toBe(0);
  });

  it("refuses control requests without the token", async () => {
    const running = await start("auto");

    await expect(
      connectRecordingProxy({ url: running.url, token: "wrong" }).stats(),
    ).rejects.toThrow("HTTP 401");
  });

  it("writes nothing for a failed session", async () => {
    const running = await start("auto");
    await session(running, [{ model: "m" }], false);
    await session(running, [{ model: "m" }], false);

    expect(liveRequests).toBe(2);
    await expect(files()).resolves.toEqual([]);
  });

  it("lists used recordings and prunes the others", async () => {
    const usedFile = path.join(
      directory,
      "..",
      `${path.basename(directory)}.used`,
    );
    const running = await start("auto", usedFile);
    await session(running, [{ model: "m" }]);
    const [file] = await files();
    const content = await readFile(
      path.join(directory, "model", file!),
      "utf8",
    );
    await writeFile(path.join(directory, "model", "stale.json"), "{}\n");

    // A replay neither writes the file again nor makes it unused.
    await session(running, [{ model: "m" }]);
    await running.close();
    proxy = undefined;

    await expect(readFile(usedFile, "utf8")).resolves.toBe(`model/${file}\n`);
    await expect(pruneRecordings(directory, [usedFile])).resolves.toBe(1);
    await expect(files()).resolves.toEqual([file]);
    await expect(
      readFile(path.join(directory, "model", file!), "utf8"),
    ).resolves.toBe(content);
    expect(liveRequests).toBe(1);
    await rm(usedFile);
  });

  it("records again in record mode", async () => {
    const running = await start("record");
    await session(running, [{ model: "m" }]);
    const second = await session(running, [{ model: "m" }]);

    expect([...second]).toEqual([{ body: "data: 2\n\n", source: "live" }]);
    await expect(files()).resolves.toHaveLength(1);
  });
});
