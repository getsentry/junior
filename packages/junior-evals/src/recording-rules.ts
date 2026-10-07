/**
 * The traffic that evals record.
 *
 * Global setup starts the recording proxy in `src/recording-proxy/` with
 * this configuration. The proxy knows nothing about Junior. This file is the
 * one place that decides which eval requests are recorded and replayed. To
 * record more traffic, add a rule. An environment variable sets the mode of
 * each rule. Unset means `auto`, so every eval suite records and replays.
 * Set it to `off` to send every request live without a recording.
 */
import { fileURLToPath } from "node:url";
import { USER_AGENT } from "@/chat/tools/web/constants";
import type {
  RecordingMode,
  RecordingProxyConfig,
  RecordingRule,
} from "./recording-proxy/recording-proxy";

/**
 * An ISO time. The prompt shows when each earlier message was stored, and
 * that is the clock time of the run.
 */
const ISO_TIME = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z`;

const RECORDING_RULES: Array<
  Omit<RecordingRule, "mode"> & { modeEnv: string }
> = [
  {
    // Agent, title, and judge requests to the AI Gateway. The gateway
    // observer mocks image generation and web search before the proxy.
    name: "model",
    modeEnv: "JUNIOR_EVAL_MODEL_REPLAY",
    method: "POST",
    urlPrefix: "https://ai-gateway.vercel.sh/",
    ignore: [ISO_TIME],
    // AI SDK gateway requests, such as `/v3/ai/language-model`, name the
    // model in a header, not in the body.
    keyHeaders: [
      "ai-language-model-id",
      "ai-language-model-streaming",
      "ai-model-id",
    ],
  },
  {
    // Public pages that the `webFetch` tool reads.
    name: "web",
    modeEnv: "VITEST_EVALS_REPLAY_MODE",
    method: "GET",
    headers: { "user-agent": USER_AGENT },
  },
];

/**
 * The only origins that eval traffic can reach through the proxy. The proxy
 * refuses all other origins. MSW mocks, such as Slack and GitHub, answer
 * before the proxy, so they are not in this list. To let an eval reach a new
 * site, add its origin here.
 */
const ALLOWED_ORIGINS = [
  // Agent, title, and judge requests.
  "https://ai-gateway.vercel.sh",
  // The Vercel Sandbox API and Vercel OIDC tokens.
  "https://vercel.com",
  "https://api.vercel.com",
  "https://oidc.vercel.com",
  // Pages that `webFetch` evals read.
  "https://docs.slack.dev",
];

/** The committed recordings of the eval package. */
const RECORDINGS_DIR = fileURLToPath(new URL("../recordings", import.meta.url));

function readMode(name: string): RecordingMode {
  const value = process.env[name]?.trim() || "auto";
  if (value === "auto" || value === "off" || value === "record") return value;
  throw new Error(`${name} must be off, auto, or record, got ${value}`);
}

/** The recording proxy configuration of this eval run. */
export function recordingProxyConfig(): RecordingProxyConfig {
  return {
    directory: RECORDINGS_DIR,
    origins: ALLOWED_ORIGINS,
    rules: RECORDING_RULES.map(({ modeEnv, ...rule }) => ({
      ...rule,
      mode: readMode(modeEnv),
    })),
  };
}
