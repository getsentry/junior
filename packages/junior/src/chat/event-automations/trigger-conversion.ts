/**
 * Turn event automation triggers with an identifier into triggers with no
 * identifier that select the same events.
 *
 * Plugins own their identifier formats through `identifierMatch`. Core owns
 * the rule: a trigger converts only when its plugin gives one set of filters
 * for every selected event, the filters agree with the saved filters, and the
 * result passes the same check as a new trigger. Otherwise the trigger keeps
 * its identifier, so it never gets broader.
 */
import {
  stableEventMatchKey,
  type EventMatch,
} from "@sentry/junior-plugin-api";
import {
  AutomationConflictError,
  automationRevision,
} from "@/chat/automations/revision";
import {
  automationEventCatalog,
  registeredEventTriggerProblems,
  type EventCatalog,
} from "@/chat/events/catalog";
import { logException, logInfo } from "@/chat/logging";
import type { JuniorDatabase } from "@/db/db";
import {
  listEventAutomationsWithIdentifier,
  saveEventAutomation,
} from "./store";
import type { EventAutomation } from "./types";

type EventAutomationTrigger = EventAutomation["trigger"];

/** A trigger with no identifier, or why the trigger keeps its identifier. */
export type TriggerConversion =
  | { trigger: EventAutomationTrigger }
  | { reason: string };

function sameValue(left: EventMatch[string], right: EventMatch[string]) {
  return (
    stableEventMatchKey({ value: left }) ===
    stableEventMatchKey({ value: right })
  );
}

/**
 * Return the trigger with no identifier that selects the same events as this
 * trigger, or why it cannot. A trigger with no identifier stays as it is.
 */
export function triggerWithoutIdentifier(
  catalog: EventCatalog,
  trigger: EventAutomationTrigger,
): TriggerConversion {
  const { identifier, resourceType: _resourceType, ...rest } = trigger;
  if (identifier === undefined) return { trigger };
  const plugins = automationEventCatalog(catalog);
  const toMatch = plugins[trigger.namespace]?.identifierMatch;
  if (!toMatch) {
    return {
      reason: `The ${trigger.namespace} source cannot turn identifiers into filters.`,
    };
  }
  let scope: EventMatch | undefined;
  for (const eventType of trigger.events) {
    const match = toMatch({ identifier, eventType });
    if (!match) {
      return {
        reason: `Identifier "${identifier}" cannot become filters for "${eventType}" without matching other events.`,
      };
    }
    if (scope && stableEventMatchKey(scope) !== stableEventMatchKey(match)) {
      return {
        reason: `Identifier "${identifier}" needs different filters for different events.`,
      };
    }
    scope = match;
  }
  for (const [key, value] of Object.entries(scope ?? {})) {
    const saved = trigger.match?.[key];
    if (saved !== undefined && !sameValue(saved, value)) {
      return {
        reason: `Filter "${key}" already has a value that identifier "${identifier}" does not have.`,
      };
    }
  }
  const match = { ...trigger.match, ...scope };
  const problems = registeredEventTriggerProblems(plugins, {
    namespace: trigger.namespace,
    events: trigger.events,
    match,
  });
  if (problems.length > 0) {
    return { reason: problems.map((problem) => problem.message).join(" ") };
  }
  return { trigger: { ...rest, match } };
}

/**
 * Convert every saved event automation trigger that still has an identifier
 * and that `triggerWithoutIdentifier` can convert. Each save locks the row,
 * checks that the row did not change after it was read, and records a new
 * version with no editor. A row that changed is left for the next run. Other
 * rows keep their identifier and keep running.
 */
export async function convertSavedEventAutomationTriggers(
  db: JuniorDatabase,
  catalog: EventCatalog,
): Promise<{ converted: string[]; kept: { id: string; reason: string }[] }> {
  const converted: string[] = [];
  const kept: { id: string; reason: string }[] = [];
  for (const task of await listEventAutomationsWithIdentifier(db)) {
    try {
      const conversion = triggerWithoutIdentifier(catalog, task.trigger);
      if ("reason" in conversion) {
        kept.push({ id: task.id, reason: conversion.reason });
        continue;
      }
      const saved = await saveEventAutomation(
        db,
        { ...task, trigger: conversion.trigger },
        automationRevision(task),
      );
      if (!saved) continue;
      converted.push(task.id);
      logInfo("event_automation.trigger.converted", {
        "app.task.id": task.id,
        "app.task.type": "event",
      });
    } catch (error) {
      if (error instanceof AutomationConflictError) continue;
      logException(error, "event_automation.trigger.conversion_failed", {
        "app.task.id": task.id,
        "app.task.type": "event",
      });
    }
  }
  return { converted, kept };
}
