// The one place the host reads the process globals that core needs.
import type { ChatConfig } from "@/chat/config";
import { getSqlExecutor } from "@/chat/db";
import { getQueueProvider } from "@/chat/queue/provider";
import type { EngineContext } from "@/core/engine-context";
import { SERVICE_INSTANCE_ID } from "@/deployment";

/** Builds the context that core's Turn engine runs with. */
export function createEngineContext(config: ChatConfig): EngineContext {
  return {
    executor: getSqlExecutor(),
    queue: getQueueProvider(),
    // The id that the process's spans carry as `service.instance.id`. The
    // lease epoch, not the owner, fences the writes.
    owner: SERVICE_INSTANCE_ID,
    // The host stops a step at the function's max duration, so the lease ends
    // then too. The queue sends the message again 30 s after that, and the
    // claim of that delivery finds the lease expired.
    leaseMs: config.functionMaxDurationSeconds * 1000,
  };
}
