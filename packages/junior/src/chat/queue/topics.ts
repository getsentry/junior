/**
 * Queue topic names. Vercel queue wiring uses them at build, so keep them
 * stable, and keep this module free of runtime configuration.
 */

export const CACHE_WARMUP_QUEUE_TOPIC = "junior_cache_warmups";
export const PLUGIN_TASK_QUEUE_TOPIC = "junior_plugin_tasks";
export const WORKSPACE_SNAPSHOT_JOB_QUEUE_TOPIC = "junior_workspace_snapshots";
export const BACKGROUND_COMPACTION_QUEUE_TOPIC = "junior_context_compaction";
export const DEFAULT_CONVERSATION_WORK_QUEUE_TOPIC = "junior_conversation_work";
/** Queue topic of Turn step messages. */
export const TURN_STEP_TOPIC = "junior_turn_step";
/** Queue topic of delivery messages. */
export const DELIVERY_TOPIC = "junior_delivery";

/** Resolve the Vercel Queue topic used for conversation wake-up nudges. */
export function resolveConversationWorkQueueTopic(
  options: { topic?: string | undefined } = {},
): string {
  const topic = options.topic?.trim();
  return (
    topic ||
    process.env["JUNIOR_CONVERSATION_WORK_QUEUE_TOPIC"]?.trim() ||
    DEFAULT_CONVERSATION_WORK_QUEUE_TOPIC
  );
}
