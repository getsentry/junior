import { open, readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const PROFILE = new URL("../assets/junior-v1.json", import.meta.url);
const ENDPOINT = "https://ai-gateway.vercel.sh/v4/ai/speech-model";
const HELP = `Generate Gemini speech through Junior's host-managed AI Gateway key.
node scripts/speech.mjs --text-file FILE --output FILE.wav [--delivery playful|plain]
node scripts/speech.mjs --sample --output FILE.wav
node scripts/speech.mjs --profile

Paid requests are not retried. Existing output files are never overwritten.
No API key argument is accepted.`;

/** Decode and check Gateway WAV audio before making it available for delivery. */
export function decodeAudio(result) {
  if (
    typeof result.audio !== "string" ||
    !result.audio.length ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      result.audio,
    )
  ) {
    throw new Error("Gateway did not return valid base64 audio.");
  }
  const audio = Buffer.from(result.audio, "base64");
  if (
    audio.length <= 44 ||
    audio.toString("ascii", 0, 4) !== "RIFF" ||
    audio.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("Gateway did not return a WAV file.");
  }
  if (audio.readUInt32LE(4) + 8 !== audio.length) {
    throw new Error("Gateway returned an incomplete WAV file.");
  }
  return audio;
}

/** Generate a single clip; style stays separate from the spoken text. */
export async function generateSpeech(text, output, delivery = "playful") {
  if (!text.trim() || [...text].length > 5000) {
    throw new Error(
      "Use 1–5000 characters per clip. Split longer narration into scenes.",
    );
  }
  if (!["playful", "plain"].includes(delivery))
    throw new Error("Choose playful or plain delivery.");
  if (!output.endsWith(".wav"))
    throw new Error("Output must have a .wav extension.");
  const profile = JSON.parse(await readFile(PROFILE, "utf8"));
  const instructions =
    delivery === "plain"
      ? "Speak warmly, clearly, and calmly, like a capable adult teammate. Use natural conversational pacing. No snark, jokes, teasing, or dramatic performance. Read only the supplied text."
      : profile.instructions;
  const path = resolve(output);
  const file = await open(path, "wx", 0o600);
  let completed = false;
  try {
    // The plugin's host proxy supplies Authorization. Never read a key here.
    const response = await fetch(ENDPOINT, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
      headers: {
        "Content-Type": "application/json",
        "ai-gateway-protocol-version": "0.0.1",
        "ai-speech-model-specification-version": "4",
        "ai-model-id": profile.model,
      },
      body: JSON.stringify({
        text,
        voice: profile.voice,
        instructions,
        outputFormat: "wav",
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const hint =
        response.status === 401 || response.status === 403
          ? "Check the host-side AI_GATEWAY_API_KEY and team speech access."
          : response.status === 402
            ? "Check Gateway credits and spending limits."
            : response.status === 404
              ? "Check Gemini TTS availability for the Gateway team."
              : "Check Gateway usage and provider status.";
      throw new Error(`Gateway HTTP ${response.status}. ${hint}`);
    }
    let result;
    try {
      result = await response.json();
    } catch {
      // JSON parse errors can quote provider response data. Keep it out of logs.
      throw new Error("Gateway did not return a valid speech response.");
    }
    // Unsupported delivery options must not silently produce the wrong voice.
    if (Array.isArray(result.warnings) && result.warnings.length) {
      throw new Error(
        "Gateway returned speech warnings. Review model support before generating again.",
      );
    }
    const audio = decodeAudio(result);
    await file.writeFile(audio);
    completed = true;
    return {
      path,
      bytes: audio.length,
      mimeType: "audio/wav",
      model: profile.model,
      voice: profile.voice,
      profile: profile.name,
      delivery,
      synthetic: true,
    };
  } catch (error) {
    throw new Error(
      "Speech did not finish locally. Credits may have been used. Check Gateway usage before retrying; no automatic retry was made.",
      { cause: error },
    );
  } finally {
    await file.close();
    if (!completed) await unlink(path);
  }
}

/** Parse the bounded speech CLI, including the bundled sample and profile. */
export async function run(args) {
  const { values } = parseArgs({
    args,
    options: {
      "text-file": { type: "string" },
      output: { type: "string" },
      delivery: { type: "string" },
      sample: { type: "boolean" },
      profile: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) return { help: HELP };
  if (values.profile) {
    if (Object.keys(values).length !== 1)
      throw new Error("Use --profile alone.");
    return JSON.parse(await readFile(PROFILE, "utf8"));
  }
  if (
    !values.output ||
    Boolean(values.sample) === Boolean(values["text-file"])
  ) {
    throw new Error(
      "Provide --output and exactly one of --sample or --text-file.",
    );
  }
  const source = values.sample
    ? new URL("../assets/sample.txt", import.meta.url)
    : values["text-file"];
  return generateSpeech(
    await readFile(source, "utf8"),
    values.output,
    values.delivery,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    console.log(JSON.stringify(await run(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(error.message);
    if (error.cause instanceof Error) console.error(error.cause.message);
    process.exitCode = 1;
  }
}
