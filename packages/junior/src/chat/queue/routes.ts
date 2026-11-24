import {
  BACKGROUND_COMPACTION_QUEUE_TOPIC,
  CACHE_WARMUP_QUEUE_TOPIC,
  PLUGIN_TASK_QUEUE_TOPIC,
  resolveConversationWorkQueueTopic,
  WORKSPACE_SNAPSHOT_JOB_QUEUE_TOPIC,
} from "@/chat/queue/topics";
import { DELIVERY_TOPIC } from "@/core/delivery/topic";
import { TURN_STEP_TOPIC } from "@/core/turn/topic";
import {
  JUNIOR_CACHE_WARMUP_CALLBACK_ROUTE,
  JUNIOR_CONTEXT_COMPACTION_CALLBACK_ROUTE,
  JUNIOR_CONVERSATION_WORK_CALLBACK_ROUTE,
  JUNIOR_DELIVERY_CALLBACK_ROUTE,
  JUNIOR_PLUGIN_TASK_CALLBACK_ROUTE,
  JUNIOR_TURN_STEP_CALLBACK_ROUTE,
  JUNIOR_WORKSPACE_SNAPSHOT_JOB_CALLBACK_ROUTE,
} from "@/deployment";

/**
 * Return the callback route of each queue topic. The queue pushes each
 * message of a topic to its route.
 */
export function queueCallbackRoutes(): { route: string; topic: string }[] {
  return [
    {
      route: JUNIOR_CONVERSATION_WORK_CALLBACK_ROUTE,
      topic: resolveConversationWorkQueueTopic(),
    },
    {
      route: JUNIOR_PLUGIN_TASK_CALLBACK_ROUTE,
      topic: PLUGIN_TASK_QUEUE_TOPIC,
    },
    {
      route: JUNIOR_WORKSPACE_SNAPSHOT_JOB_CALLBACK_ROUTE,
      topic: WORKSPACE_SNAPSHOT_JOB_QUEUE_TOPIC,
    },
    {
      route: JUNIOR_CACHE_WARMUP_CALLBACK_ROUTE,
      topic: CACHE_WARMUP_QUEUE_TOPIC,
    },
    {
      route: JUNIOR_CONTEXT_COMPACTION_CALLBACK_ROUTE,
      topic: BACKGROUND_COMPACTION_QUEUE_TOPIC,
    },
    { route: JUNIOR_TURN_STEP_CALLBACK_ROUTE, topic: TURN_STEP_TOPIC },
    { route: JUNIOR_DELIVERY_CALLBACK_ROUTE, topic: DELIVERY_TOPIC },
  ];
}
