import { open, readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const API = "https://api.elevenlabs.io";
const VOICE_ID = /^[A-Za-z0-9]{20}$/;
const HELP = `ElevenLabs (host-managed credentials; no key argument)
  node scripts/elevenlabs.mjs voices [--search TEXT]
  node scripts/elevenlabs.mjs voice --voice ID_OR_LINK
  node scripts/elevenlabs.mjs speak --voice ID_OR_LINK --text-file FILE --output FILE.mp3 [--model MODEL_ID]

Speech spends credits. Requests are not retried. Existing output files are never overwritten.`;

/** Extract a voice ID without fetching or trusting the supplied URL. */
export function resolveVoice(input) {
  if (VOICE_ID.test(input)) return input;
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Provide a voice ID or an HTTPS ElevenLabs voice link.");
  }
  if (
    url.protocol !== "https:" ||
    !["elevenlabs.io", "www.elevenlabs.io"].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error(
      "Use an HTTPS elevenlabs.io voice link without credentials or a fragment.",
    );
  }
  const path = url.pathname.replace(/\/$/, "");
  let id;
  if (["/app/voice-library", "/app/voice-lab"].includes(path)) {
    const ids = url.searchParams.getAll("voiceId");
    if (ids.length === 1) id = ids[0];
  } else {
    // Shared links contain the public owner ID, then the voice ID.
    const shared =
      /^\/(?:app\/)?voice-lab\/share\/[A-Za-z0-9]+\/([A-Za-z0-9]{20})$/.exec(
        path,
      );
    id = shared?.[1];
  }
  if (!id || !VOICE_ID.test(id)) {
    throw new Error(
      "This link has no supported voice ID. In ElevenLabs, use Copy voice ID or share a voice-library link with voiceId.",
    );
  }
  return id;
}

async function request(path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    // The host proxy adds xi-api-key. Never read it in the Sandbox.
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    const hints = {
      401: "Ask the operator to check the deployment's ELEVENLABS_API_KEY.",
      403: "Check the key's scopes, voice access, and account plan with the operator.",
      404: "The voice is unavailable. Ask the user to check the voice link and account access.",
      429: "The account is rate-limited or out of credits. Check usage before trying again.",
    };
    throw new Error(
      `ElevenLabs HTTP ${response.status}. ${hints[response.status] ?? "The request failed; check the provider before trying again."} No automatic retry was made.`,
    );
  }
  return response;
}

async function getVoice(id) {
  const response = await request(`/v1/voices/${id}`);
  const voice = await response.json();
  if (voice.voice_id !== id || typeof voice.name !== "string") {
    throw new Error("ElevenLabs returned invalid voice metadata.");
  }
  return {
    voiceId: voice.voice_id,
    name: voice.name,
    category: voice.category,
  };
}

/** Generate one MP3 with validated voice selection and exclusive file creation. */
export async function generateSpeech(
  voice,
  textFile,
  output,
  model = "eleven_multilingual_v2",
) {
  const id = resolveVoice(voice);
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(model))
    throw new Error("Invalid model ID.");
  if (!output.endsWith(".mp3"))
    throw new Error("Output must have an .mp3 extension.");
  const text = await readFile(textFile, "utf8");
  if (!text.trim() || [...text].length > 5000) {
    throw new Error(
      "Use 1–5000 characters per speech request. Split longer narration into scenes.",
    );
  }
  const path = resolve(output);
  // Reserve before any paid request. A rerun cannot overwrite an existing clip.
  const file = await open(path, "wx", 0o600);
  let completed = false;
  let generationStarted = false;
  try {
    const selected = await getVoice(id);
    generationStarted = true;
    const response = await request(
      `/v1/text-to-speech/${id}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: model }),
      },
    );
    if (
      !response.headers
        .get("content-type")
        ?.split(";")[0]
        .trim()
        .match(/^audio\/(mpeg|mp3)$/)
    ) {
      await response.body?.cancel();
      throw new Error("ElevenLabs did not return MP3 audio.");
    }
    const audio = Buffer.from(await response.arrayBuffer());
    if (audio.length === 0) throw new Error("ElevenLabs returned empty audio.");
    await file.writeFile(audio);
    completed = true;
    return {
      path,
      bytes: audio.length,
      mimeType: "audio/mpeg",
      voice: selected,
      model,
    };
  } catch (error) {
    if (generationStarted) {
      throw new Error(
        "Speech generation did not finish locally. Credits may have been used. Check ElevenLabs history before retrying.",
        { cause: error },
      );
    }
    throw error;
  } finally {
    await file.close();
    if (!completed) await unlink(path);
  }
}

/** Run the small voice lookup and speech command surface. */
export async function run(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      voice: { type: "string" },
      "text-file": { type: "string" },
      output: { type: "string" },
      model: { type: "string" },
      search: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) return { help: HELP };
  const [command] = positionals;
  const allowed = {
    voices: ["search"],
    voice: ["voice"],
    speak: ["voice", "text-file", "output", "model"],
  };
  if (
    positionals.length !== 1 ||
    !Object.hasOwn(allowed, command) ||
    Object.keys(values).some((key) => !allowed[command].includes(key))
  ) {
    throw new Error(HELP);
  }
  if (command === "voices") {
    const params = new URLSearchParams({
      page_size: "20",
      include_total_count: "false",
    });
    if (values.search) params.set("search", values.search);
    const response = await request(`/v2/voices?${params}`);
    const result = await response.json();
    return {
      voices: result.voices.map((v) => ({
        voiceId: v.voice_id,
        name: v.name,
        category: v.category,
      })),
      hasMore: result.has_more,
    };
  }
  if (!values.voice)
    throw new Error("Provide --voice with an ID or voice link.");
  if (command === "voice") return getVoice(resolveVoice(values.voice));
  if (!values["text-file"] || !values.output)
    throw new Error("Provide --text-file and --output.");
  return generateSpeech(
    values.voice,
    values["text-file"],
    values.output,
    values.model,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    console.log(JSON.stringify(await run(process.argv.slice(2)), null, 2));
  } catch (error) {
    // Do not print request headers, response bodies, input text, or stack traces.
    console.error(error.message);
    if (error.cause instanceof Error) console.error(error.cause.message);
    process.exitCode = 1;
  }
}
