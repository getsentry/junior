/**
 * The traffic that evals record.
 *
 * Global setup starts the recording proxy in `src/recording-proxy/` with
 * this configuration. The proxy knows nothing about Junior. This file is the
 * one place that decides which eval requests are recorded and replayed. To
 * record more traffic, add a rule. `VITEST_EVALS_REPLAY_MODE` sets the mode.
 * Unset means `auto`. `EVAL_RECORDINGS_USED_FILE` names a file where the
 * proxy lists the recordings that passing tests used. The nightly workflow
 * gives these files to `recording-proxy.ts prune`.
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

const RECORDING_RULES: RecordingRule[] = [
  {
    // Every model request to the AI Gateway. The gateway observer mocks
    // image generation and web search before the proxy.
    name: "model",
    match: { method: "POST", url: "https://ai-gateway.vercel.sh/" },
    key: {
      // AI SDK gateway requests, such as `/v3/ai/language-model`, name the
      // model in a header, not in the body.
      headers: [
        "ai-language-model-id",
        "ai-language-model-streaming",
        "ai-model-id",
      ],
      ignore: [ISO_TIME],
    },
  },
  {
    // Public pages that the `webFetch` tool reads.
    name: "web",
    match: { method: "GET", headers: { "user-agent": USER_AGENT } },
  },
];

/**
 * The only origins that eval traffic can reach through the proxy. The proxy
 * refuses all other origins. MSW mocks, such as Slack and GitHub, answer
 * before the proxy, so they are not in this list. To let an eval reach a new
 * site, add its origin here.
 */
const ALLOWED_ORIGINS = [
  // Model requests.
  "https://ai-gateway.vercel.sh",
  // The Vercel Sandbox API and Vercel OIDC tokens.
  "https://vercel.com",
  "https://api.vercel.com",
  "https://oidc.vercel.com",
  // Pages that `webFetch` evals read.
  "https://docs.slack.dev",
];

/**
 * Hosts that do not use the proxy. Local fixture servers, Postgres, and
 * Redis are on loopback. The Quick Tunnel of the sandbox egress
 * (`src/eval-egress.ts`) is on Cloudflare, which the CI network allows
 * directly (`scripts/network-jail.sh`).
 */
export const NO_PROXY = "localhost,127.0.0.1,::1,.trycloudflare.com";

/** The committed recordings of the eval package. */
const RECORDINGS_DIR = fileURLToPath(new URL("../recordings", import.meta.url));

function readMode(): RecordingMode {
  const value = process.env.VITEST_EVALS_REPLAY_MODE?.trim() || "auto";
  if (value === "auto" || value === "off" || value === "record") return value;
  throw new Error(
    `VITEST_EVALS_REPLAY_MODE must be off, auto, or record, got ${value}`,
  );
}

/** The recording proxy configuration of this eval run. */
export function recordingProxyConfig(): RecordingProxyConfig {
  return {
    directory: RECORDINGS_DIR,
    mode: readMode(),
    allow: ALLOWED_ORIGINS,
    rules: RECORDING_RULES,
    usedFile: process.env.EVAL_RECORDINGS_USED_FILE?.trim() || undefined,
  };
}
