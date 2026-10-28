import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  decodeAudio,
  generateSpeech,
  run,
} from "../skills/tts/scripts/speech.mjs";

function wav() {
  const bytes = Buffer.alloc(48);
  bytes.write("RIFF");
  bytes.writeUInt32LE(40, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24000, 24);
  bytes.writeUInt32LE(48000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(4, 40);
  return bytes;
}
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), "junior-tts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("Gateway request keeps style separate and writes WAV without a Sandbox key", async (t) => {
  const dir = await directory(t);
  const output = join(dir, "sample.wav");
  const audio = wav();
  const fetch = t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://ai-gateway.vercel.sh/v4/ai/speech-model");
    assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).has("authorization"), false);
    assert.equal(init.headers["ai-model-id"], "google/gemini-3.8-flash-tts");
    assert.equal(init.headers["ai-speech-model-specification-version"], "4");
    const body = JSON.parse(init.body);
    assert.equal(body.text, "Ship it. After the tests.");
    assert.equal(body.voice, "Puck");
    assert.equal(body.outputFormat, "wav");
    assert.match(body.instructions, /mischievous/);
    return Response.json({ audio: audio.toString("base64"), warnings: [] });
  });
  const result = await generateSpeech("Ship it. After the tests.", output);
  assert.equal(result.profile, "junior-v1");
  assert.equal(result.mimeType, "audio/wav");
  assert.equal(result.synthetic, true);
  assert.deepEqual(await readFile(output), audio);
  await assert.rejects(generateSpeech("Again", output), { code: "EEXIST" });
  assert.equal(fetch.mock.callCount(), 1);
});

test("plain delivery removes snark without changing the selected voice", async (t) => {
  const dir = await directory(t);
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.match(body.instructions, /No snark/);
    assert.equal(body.voice, "Puck");
    return Response.json({ audio: wav().toString("base64") });
  });
  await generateSpeech(
    "The service is unavailable.",
    join(dir, "plain.wav"),
    "plain",
  );
});

test("failed, interrupted, and unsupported generations leave no file or automatic retry", async (t) => {
  const dir = await directory(t);
  for (const failure of ["auth", "timeout", "warnings", "empty"]) {
    const fetch = t.mock.method(globalThis, "fetch", async () => {
      if (failure === "auth")
        return new Response("private detail", { status: 401 });
      if (failure === "timeout") throw new Error("Timed out");
      return Response.json({
        audio: failure === "empty" ? "" : wav().toString("base64"),
        warnings: failure === "warnings" ? [{ type: "unsupported" }] : [],
      });
    });
    await assert.rejects(
      generateSpeech("Hello", join(dir, "failed.wav")),
      /Credits may have been used/,
    );
    assert.equal(fetch.mock.callCount(), 1);
    assert.deepEqual(await readdir(dir), []);
    fetch.mock.restore();
  }
});

test("profile and sample are reusable and local validation prevents paid calls", async (t) => {
  const dir = await directory(t);
  const fetch = t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.match(JSON.parse(init.body).text, /Hey, I'm Junior/);
    return Response.json({ audio: wav().toString("base64") });
  });
  assert.equal((await run(["--profile"])).name, "junior-v1");
  await assert.rejects(run(["--api-key", "not-a-secret"]), /Unknown option/);
  await assert.rejects(
    generateSpeech("x".repeat(5001), join(dir, "long.wav")),
    /1–5000/,
  );
  await assert.rejects(generateSpeech("Hello", join(dir, "wrong.mp3")), /wav/);
  assert.equal(fetch.mock.callCount(), 0);
  await run(["--sample", "--output", join(dir, "sample.wav")]);
  assert.equal(fetch.mock.callCount(), 1);
});

test("invalid or truncated audio is not labeled WAV", () => {
  for (const audio of [
    "%%%",
    Buffer.from("not audio").toString("base64"),
    wav().subarray(0, 47).toString("base64"),
  ]) {
    assert.throws(() => decodeAudio({ audio }));
  }
});
