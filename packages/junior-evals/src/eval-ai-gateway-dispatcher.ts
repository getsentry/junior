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

function requestOrigin(origin: Dispatcher.DispatchOptions["origin"]): string {
  if (!origin) return "";
  return typeof origin === "string" ? new URL(origin).origin : origin.origin;
}

/** Install an eval-scoped body timeout for AI Gateway provider requests. */
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
          ? { ...options, bodyTimeout: bodyTimeoutMs }
          : options,
        handler,
      ),
  );
  setGlobalDispatcher(dispatcher);

  return async () => {
    setGlobalDispatcher(previousDispatcher);
  };
}
