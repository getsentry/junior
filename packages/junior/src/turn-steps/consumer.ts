// Runs the core Turn engine on this deployment: the queue consumer of Turn
// step messages, with the host's prompt layouts and model settings, and the
// model client, bot settings and tools that the host passes in.
// oxlint-disable-next-line no-restricted-imports -- The core Turn's model stream. Each reply keeps its usage in history; Conversation cost metrics do not count it yet.
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { getGatewayApiKey, resolveGatewayModel } from "@/chat/pi/client";
import type { BotConfig } from "@/chat/config";
import type { QueueConsumer } from "@/chat/queue/provider";
import type { EngineContext } from "@/core/engine-context";
import { modelClient, type ModelClient } from "@/core/model/client";
import { advanceTurn } from "@/core/turn/advance";
import { createTurnStepConsumer } from "@/core/turn/queue";
import type { ToolDefinition } from "@/core/tool";
import {
  buildTurnPromptLayouts,
  turnModelSettings,
  turnPromptLayout,
} from "./prompt";

// A step that fails this many times fails its Turn. A try that throws and a
// model request that fails in a way that can work later both count, so a
// step gets main's three provider retries. A try that throws can take a full
// lease.
const MAX_ATTEMPTS = 4;

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
 * `engineCtx.queue`, and gives the model client, the bot settings and the
 * tools that its steps use. It builds the prompt layouts once.
 */
export async function turnStepConsumer(
  engineCtx: EngineContext,
  {
    client,
    bot,
    tools,
  }: { client: ModelClient; bot: BotConfig; tools: ToolDefinition[] },
): Promise<QueueConsumer> {
  const prompt = turnPromptLayout(engineCtx, await buildTurnPromptLayouts());
  const modelSettings = turnModelSettings({
    executor: engineCtx.executor,
    bot,
  });
  return createTurnStepConsumer(engineCtx, (message) =>
    advanceTurn(engineCtx, message, {
      client,
      prompt,
      modelSettings,
      tools,
      maxAttempts: MAX_ATTEMPTS,
    }),
  );
}
