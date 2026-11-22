// Runs the core Turn engine on this deployment: the queue consumer of Turn
// step messages, with the AI Gateway model client and the host's `prepare`.
// oxlint-disable-next-line no-restricted-imports -- The core Turn's model stream. Each reply keeps its usage in history; Conversation cost metrics do not count it yet.
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { getChatConfig } from "@/chat/config";
import { getSqlExecutor } from "@/chat/db";
import { getGatewayApiKey, resolveGatewayModel } from "@/chat/pi/client";
import { modelClient } from "@/core/model/client";
import { advanceTurn } from "@/core/turn/advance";
import { createTurnStepConsumer } from "@/core/turn/queue";
import { SERVICE_INSTANCE_ID } from "@/deployment";
import { prepareTurnStep } from "./prepare";

// A step that throws this many times fails its Turn. A failed model request
// does not count: it fails the Turn at once. These tries are for crashes and
// infrastructure errors, and each one can take a full lease.
const MAX_ATTEMPTS = 3;

const client = modelClient({
  apiKey: getGatewayApiKey,
  resolveModel: resolveGatewayModel,
  send: streamSimple,
});

function runTurnStep(message: { turnId: string }): Promise<void> {
  return advanceTurn(getSqlExecutor(), message, {
    client,
    prepare: prepareTurnStep,
    // The id that the process's spans carry as `service.instance.id`. The
    // lease epoch, not the owner, fences the writes.
    owner: SERVICE_INSTANCE_ID,
    // The host stops a step at the function's max duration, so the lease ends
    // then too. The queue sends the message again 30 s after that, and the
    // claim of that delivery finds the lease expired.
    leaseMs: getChatConfig().functionMaxDurationSeconds * 1000,
    maxAttempts: MAX_ATTEMPTS,
  });
}

/**
 * The queue consumer of Turn step messages. The queue provider picks which
 * entry point is live. Build it after `createApp` sets the runtime config,
 * because the visibility timeout reads `functionMaxDurationSeconds`.
 */
export function turnStepConsumer() {
  return createTurnStepConsumer(runTurnStep);
}
