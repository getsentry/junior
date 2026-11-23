// Runs the core Turn engine on this deployment: the queue consumer of Turn
// step messages, with the host's `prepare` and the model client that the
// host passes in.
// oxlint-disable-next-line no-restricted-imports -- The core Turn's model stream. Each reply keeps its usage in history; Conversation cost metrics do not count it yet.
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { getGatewayApiKey, resolveGatewayModel } from "@/chat/pi/client";
import type { QueueConsumer } from "@/chat/queue/provider";
import type { EngineContext } from "@/core/engine-context";
import { modelClient, type ModelClient } from "@/core/model/client";
import { advanceTurn } from "@/core/turn/advance";
import { createTurnStepConsumer } from "@/core/turn/queue";
import { prepareTurnStep } from "./prepare";

// A step that throws this many times fails its Turn. A failed model request
// does not count: it fails the Turn at once. These tries are for crashes and
// infrastructure errors, and each one can take a full lease.
const MAX_ATTEMPTS = 3;

/** The model client of core Turns on this deployment: the AI Gateway. */
export function createGatewayModelClient(): ModelClient {
  return modelClient({
    apiKey: getGatewayApiKey,
    resolveModel: resolveGatewayModel,
    send: streamSimple,
  });
}

/**
 * The queue consumer of Turn step messages. The host mounts it on
 * `engineCtx.queue`, and gives the model client that its steps use.
 */
export function turnStepConsumer(
  engineCtx: EngineContext,
  { client }: { client: ModelClient },
): QueueConsumer {
  return createTurnStepConsumer(engineCtx, (message) =>
    advanceTurn(engineCtx, message, {
      client,
      prepare: prepareTurnStep,
      maxAttempts: MAX_ATTEMPTS,
    }),
  );
}
