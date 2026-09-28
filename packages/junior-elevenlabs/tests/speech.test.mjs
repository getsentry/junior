import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  generateSpeech,
  run,
} from "../skills/elevenlabs/scripts/elevenlabs.mjs";

const id = "JBFqnCBsd6RMkjVDRZzb";
const voice = { voice_id: id, name: "George", category: "premade" };

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "elevenlabs-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const text = join(dir, "script.txt");
  await writeFile(text, 'A demo with "quotes" and a newline.\nReady?');
  return { dir, text, output: join(dir, "speech.mp3") };
}

test("component: a linked voice produces a private MP3 with no sandbox credential", async (t) => {
  const f = await fixture(t);
  const audio = Buffer.from("ID3-test-audio");
  const fetch = t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(init.redirect, "error");
    assert.equal(new URL(url).origin, "https://api.elevenlabs.io");
    assert.equal(new Headers(init.headers).has("xi-api-key"), false);
    if (init.method !== "POST") {
      assert.equal(url, `https://api.elevenlabs.io/v1/voices/${id}`);
      return Response.json(voice);
    }
    assert.equal(
      url,
      `https://api.elevenlabs.io/v1/text-to-speech/${id}?output_format=mp3_44100_128`,
    );
    assert.deepEqual(JSON.parse(init.body), {
      text: await readFile(f.text, "utf8"),
      model_id: "eleven_multilingual_v2",
    });
    return new Response(audio, { headers: { "content-type": "audio/mpeg" } });
  });
  const result = await run([
    "speak",
    "--voice",
    `https://elevenlabs.io/app/voice-library?voiceId=${id}`,
    "--text-file",
    f.text,
    "--output",
    f.output,
  ]);
  assert.equal(result.path, f.output);
  assert.equal(result.bytes, audio.length);
  assert.equal(result.voice.name, "George");
  assert.deepEqual(await readFile(f.output), audio);
  assert.equal(fetch.mock.callCount(), 2);
  await assert.rejects(generateSpeech(id, f.text, f.output), {
    code: "EEXIST",
  });
  assert.equal(
    fetch.mock.callCount(),
    2,
    "existing clips must not trigger another paid request",
  );
});

test("component: access and generation failures leave no audio and never retry", async (t) => {
  const f = await fixture(t);
  for (const failure of ["forbidden", "rate-limit", "timeout", "non-audio"]) {
    const fetch = t.mock.method(globalThis, "fetch", async (_url, init) => {
      if (failure === "forbidden")
        return new Response("private detail", { status: 403 });
      if (init.method !== "POST") return Response.json(voice);
      if (failure === "timeout") throw new Error("Timed out");
      if (failure === "non-audio") return Response.json({ error: "not audio" });
      return new Response("private detail", { status: 429 });
    });
    await assert.rejects(generateSpeech(id, f.text, f.output), (error) => {
      assert.doesNotMatch(error.message, /private detail/);
      assert.match(
        error.message,
        failure === "forbidden" ? /HTTP 403/ : /Credits may have been used/,
      );
      return true;
    });
    assert.deepEqual(await readdir(f.dir), ["script.txt"]);
    assert.equal(fetch.mock.callCount(), failure === "forbidden" ? 1 : 2);
    fetch.mock.restore();
  }
});

test("voice search is bounded and reports partial results without account details", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const target = new URL(url);
    assert.equal(target.origin, "https://api.elevenlabs.io");
    assert.equal(target.pathname, "/v2/voices");
    assert.equal(target.searchParams.get("page_size"), "20");
    assert.equal(target.searchParams.get("search"), "calm & clear");
    assert.equal(init.redirect, "error");
    return Response.json({
      voices: [{ ...voice, samples: ["private"] }],
      has_more: true,
    });
  });
  assert.deepEqual(await run(["voices", "--search", "calm & clear"]), {
    voices: [{ voiceId: id, name: "George", category: "premade" }],
    hasMore: true,
  });
});

test("local validation prevents requests for invalid inputs and secret arguments", async (t) => {
  const f = await fixture(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected request");
  });
  await writeFile(f.text, "x".repeat(5001));
  await assert.rejects(generateSpeech(id, f.text, f.output), /1–5000/);
  await assert.rejects(
    generateSpeech("https://evil.test/voice", f.text, f.output),
    /elevenlabs.io/,
  );
  await assert.rejects(
    run(["voices", "--api-key", "not-a-key"]),
    /Unknown option/,
  );
  assert.equal(fetch.mock.callCount(), 0);
});
