import { createServer, type Server } from "node:http";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModelReplay } from "../../src/fixture/model-replay";

const SSE = "event: message_stop\ndata: {}\n\n";

let server: Server;
let origin: string;
let liveRequests: number;
let directory: string;

function modelRequest(body: unknown): Request {
  return new Request(`${origin}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  liveRequests = 0;
  server = createServer((_request, response) => {
    liveRequests += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(SSE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  origin = `http://127.0.0.1:${address.port}`;
  directory = await mkdtemp(path.join(tmpdir(), "model-replay-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

describe("model replay", () => {
  it("replays a saved response for the same request in auto mode", async () => {
    vi.stubEnv("JUNIOR_EVAL_MODEL_REPLAY", "auto");
    const recorded = createModelReplay(directory);
    await recorded.send(
      modelRequest({
        model: "m",
        messages: [{ role: "user", content: "hi", at: "2026-10-07T03:18:03Z" }],
      }),
    );
    await recorded.save();

    // Same request with other key order and another clock time.
    const replay = createModelReplay(directory);
    const response = await replay.send(
      modelRequest({
        messages: [
          { at: "2026-10-08T10:00:00.123Z", content: "hi", role: "user" },
        ],
        model: "m",
      }),
    );

    expect(response.body).toBe(SSE);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(liveRequests).toBe(1);
    expect(replay.counts()).toEqual({ live: 0, replayed: 1 });

    await replay.send(modelRequest({ model: "m", messages: ["changed"] }));
    expect(liveRequests).toBe(2);
  });

  it("writes nothing until the test saves", async () => {
    vi.stubEnv("JUNIOR_EVAL_MODEL_REPLAY", "auto");
    await createModelReplay(directory).send(modelRequest({ model: "m" }));
    await createModelReplay(directory).send(modelRequest({ model: "m" }));

    expect(liveRequests).toBe(2);
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it("sends an expired recording to the live model", async () => {
    vi.stubEnv("JUNIOR_EVAL_MODEL_REPLAY", "auto");
    const recorded = createModelReplay(directory);
    await recorded.send(modelRequest({ model: "m" }));
    await recorded.save();
    const [file] = await readdir(directory);
    const recordingPath = path.join(directory, file!);
    const recording = JSON.parse(await readFile(recordingPath, "utf8"));
    recording.writtenAt = new Date(
      Date.now() - 8 * 24 * 60 * 60 * 1000,
    ).toISOString();
    await writeFile(recordingPath, JSON.stringify(recording));

    await createModelReplay(directory).send(modelRequest({ model: "m" }));

    expect(liveRequests).toBe(2);
  });

  it("refreshes a recording in record mode", async () => {
    vi.stubEnv("JUNIOR_EVAL_MODEL_REPLAY", "record");
    for (let run = 0; run < 2; run += 1) {
      const replay = createModelReplay(directory);
      await replay.send(modelRequest({ model: "m" }));
      await replay.save();
    }

    expect(liveRequests).toBe(2);
    await expect(readdir(directory)).resolves.toHaveLength(1);
  });
});
