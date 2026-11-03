import {
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher,
} from "undici";
import { GEN_AI_SERVER_ADDRESS, GEN_AI_SERVER_PORT } from "@/chat/pi/client";

const AI_GATEWAY_ORIGIN = new URL(
  `https://${GEN_AI_SERVER_ADDRESS}:${GEN_AI_SERVER_PORT}`,
).origin;
// Leaves time for provider retry backoff and a second attempt inside the
// separate 60-second eval reply budget.
export const EVAL_AI_GATEWAY_BODY_TIMEOUT_MS = 25_000;
// Roach takes the value of each header whose name has `session` for a
// credential, and it redacts that value in the response that the agent gets.
// This header carries the Conversation ID, so a model call that names a child
// agent's Conversation ID would get `<<redacted>>`. AI Gateway only groups
// requests by it, so evals drop it.
const SESSION_AFFINITY_HEADER = "x-session-affinity";

function requestOrigin(origin: Dispatcher.DispatchOptions["origin"]): string {
  if (!origin) return "";
  return typeof origin === "string" ? new URL(origin).origin : origin.origin;
}

// `fetch` passes its headers as a plain object.
function withoutSessionAffinity(
  headers: Dispatcher.DispatchOptions["headers"],
): Dispatcher.DispatchOptions["headers"] {
  if (!headers || Array.isArray(headers) || Symbol.iterator in headers) {
    return headers;
  }
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => name.toLowerCase() !== SESSION_AFFINITY_HEADER,
    ),
  );
}

/**
 * Install eval-scoped body timeouts for AI Gateway provider requests, and drop
 * their session affinity header before they reach Roach.
 */
export function installEvalAiGatewayDispatcher(
  bodyTimeoutMs = EVAL_AI_GATEWAY_BODY_TIMEOUT_MS,
  targetOrigin = AI_GATEWAY_ORIGIN,
): () => Promise<void> {
  const previousDispatcher = getGlobalDispatcher();
  const normalizedTargetOrigin = new URL(targetOrigin).origin;
  const dispatcher = previousDispatcher.compose(
    (dispatch) => (options, handler) =>
      dispatch(
        requestOrigin(options.origin) === normalizedTargetOrigin
          ? {
              ...options,
              headers: withoutSessionAffinity(options.headers),
              headersTimeout: bodyTimeoutMs,
              bodyTimeout: bodyTimeoutMs,
            }
          : options,
        handler,
      ),
  );
  setGlobalDispatcher(dispatcher);

  return async () => {
    setGlobalDispatcher(previousDispatcher);
  };
}
