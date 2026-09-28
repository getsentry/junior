import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveVoice } from "../skills/elevenlabs/scripts/elevenlabs.mjs";

const id = "JBFqnCBsd6RMkjVDRZzb";

test("voice IDs and supported library/share links resolve to the same API ID", () => {
  for (const input of [
    id,
    `https://elevenlabs.io/app/voice-library?voiceId=${id}`,
    `https://www.elevenlabs.io/app/voice-lab/?voiceId=${id}&source=share`,
    `https://elevenlabs.io/voice-lab/share/abcdef1234/${id}`,
    `https://elevenlabs.io/app/voice-lab/share/abcdef1234/${id}/`,
  ])
    assert.equal(resolveVoice(input), id);
});

test("untrusted or ambiguous links cannot select an API target", () => {
  for (const input of [
    "George",
    "sk_secret",
    "../voices",
    "https://elevenlabs.io/app/voice-library",
    `http://elevenlabs.io/app/voice-library?voiceId=${id}`,
    `https://elevenlabs.io.evil.test/app/voice-library?voiceId=${id}`,
    `https://evil.test/${id}`,
    `https://user:password@elevenlabs.io/app/voice-library?voiceId=${id}`,
    `https://elevenlabs.io:8080/app/voice-library?voiceId=${id}`,
    `https://elevenlabs.io/other?voiceId=${id}`,
    `https://elevenlabs.io/app/voice-library?voiceId=${id}&voiceId=${id}`,
    "https://elevenlabs.io/app/voice-library?voiceId=..%2Fsecret",
    `https://elevenlabs.io/app/voice-library#voiceId=${id}`,
  ])
    assert.throws(() => resolveVoice(input));
});
