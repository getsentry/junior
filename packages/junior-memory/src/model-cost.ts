import type {
  PluginConversationEventCostDay,
  PluginConversationEventStats,
} from "@sentry/junior-plugin-api";
import { pluginModelCostEventNames } from "@sentry/junior-plugin-api";

type MemoryCostFlow = {
  /** Memory event that one run of the flow emits. */
  eventName: "memories_captured" | "memories_recalled";
  /** Plugin context whose model calls the flow makes. */
  source: "task" | "userPrompt";
};

/** Passive extraction runs in a plugin task. */
export const extractionCostFlow: MemoryCostFlow = {
  eventName: "memories_captured",
  source: "task",
};

/** Automatic recall runs in the `userPrompt` hook. */
export const recallCostFlow: MemoryCostFlow = {
  eventName: "memories_recalled",
  source: "userPrompt",
};

function withModelCost(
  eventDays: PluginConversationEventCostDay[],
  modelDays: PluginConversationEventCostDay[],
): PluginConversationEventCostDay[] {
  // Junior records the model cost of each call. Memory events stored before
  // that carry their own cost, so add both.
  return eventDays.map((day, index) => ({
    ...day,
    costUsd: day.costUsd + (modelDays[index]?.costUsd ?? 0),
  }));
}

/** Read daily run counts and model cost of one memory flow. */
export async function memoryCostsByDay(
  stats: PluginConversationEventStats,
  flow: MemoryCostFlow,
  days: 7 | 30 | 90,
): Promise<PluginConversationEventCostDay[]> {
  const [eventDays, modelDays] = await Promise.all([
    stats.costsByDay({ days, eventName: flow.eventName }),
    stats.costsByDay({
      days,
      eventName: pluginModelCostEventNames[flow.source],
    }),
  ]);
  return withModelCost(eventDays, modelDays);
}

/** Read hourly run counts and model cost of one memory flow. */
export async function memoryCostsByHour(
  stats: PluginConversationEventStats,
  flow: MemoryCostFlow,
  hours: number,
): Promise<PluginConversationEventCostDay[]> {
  const [eventHours, modelHours] = await Promise.all([
    stats.costsByHour({ eventName: flow.eventName, hours }),
    stats.costsByHour({
      eventName: pluginModelCostEventNames[flow.source],
      hours,
    }),
  ]);
  return withModelCost(eventHours, modelHours);
}
