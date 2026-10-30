/**
 * Turn event automation triggers with an identifier into triggers with no
 * identifier that select the same events.
 *
 * Plugins own their identifier formats through `identifierMatch`. Core owns
 * the rule: a trigger converts only when its plugin gives one set of filters
 * for every selected event, the filters agree with the saved filters, and the
 * result passes the same check as a new trigger. Otherwise the trigger keeps
 * its identifier and a plain reason, so it never gets broader.
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
import { listEventAutomationsToConvert, saveEventAutomation } from "./store";
import type { EventAutomation } from "./types";

type EventAutomationTrigger = EventAutomation["trigger"];

/**
 * A trigger with no identifier, or the trigger with its identifier and the
 * reason that it keeps it.
 */
export type TriggerConversion =
  | { converted: true; trigger: EventAutomationTrigger }
  | { converted: false; trigger: EventAutomationTrigger; reason: string };

function sameValue(left: EventMatch[string], right: EventMatch[string]) {
  return (
    stableEventMatchKey({ value: left }) ===
    stableEventMatchKey({ value: right })
  );
}

/** Why the trigger keeps its identifier, in words for the people who own it. */
function keptReason(trigger: EventAutomationTrigger, why: string): string {
  const resource = trigger.resourceType?.replaceAll("_", " ") ?? "resource";
  return `Kept its exact ${resource} because ${why}.`;
}

/**
 * Return the trigger with no identifier that selects the same events as this
 * trigger. When no such trigger exists, return the trigger with its
 * identifier and the reason. A trigger with no identifier stays as it is.
 */
export function triggerWithoutIdentifier(
  catalog: EventCatalog,
  trigger: EventAutomationTrigger,
): TriggerConversion {
  const {
    identifier,
    resourceType: _resourceType,
    identifierReason: _identifierReason,
    ...rest
  } = trigger;
  if (identifier === undefined) return { converted: true, trigger };
  const keep = (why: string): TriggerConversion => {
    const reason = keptReason(trigger, why);
    return {
      converted: false,
      trigger: { ...trigger, identifierReason: reason },
      reason,
    };
  };
  const plugins = automationEventCatalog(catalog);
  const source = plugins[trigger.namespace];
  if (!source) return keep("its plugin was not enabled when Junior checked it");
  const toMatch = source.identifierMatch;
  if (!toMatch) return keep("its source cannot use filters in its place");
  let scope: EventMatch | undefined;
  for (const eventType of trigger.events) {
    const match = toMatch({ identifier, eventType });
    if (!match) return keep("no filters select the same events");
    if (scope && stableEventMatchKey(scope) !== stableEventMatchKey(match)) {
      return keep("its events need different filters");
    }
    scope = match;
  }
  for (const [key, value] of Object.entries(scope ?? {})) {
    const saved = trigger.match?.[key];
    if (saved !== undefined && !sameValue(saved, value)) {
      return keep(`its saved ${key} filter has a different value`);
    }
  }
  const match = { ...trigger.match, ...scope };
  const problems = registeredEventTriggerProblems(plugins, {
    namespace: trigger.namespace,
    events: trigger.events,
    match,
  });
  if (problems.some((problem) => problem.reason === "identifier_required")) {
    return keep("these events can only run for one resource");
  }
  if (problems.length > 0) return keep("no filters select the same events");
  return { converted: true, trigger: { ...rest, match } };
}

/** Most saved triggers that one heartbeat checks. */
const CONVERSION_BATCH_LIMIT = 50;

/**
 * Check saved event automation triggers that have an identifier and no saved
 * reason, at most `CONVERSION_BATCH_LIMIT` in one call. Save each one with
 * no identifier when `triggerWithoutIdentifier` can convert it. Otherwise
 * save the reason, so later calls skip it and people can see why. Each save
 * locks the row, checks that the row did not change after it was read, and
 * records a new version with no editor. A row that changed is left for the
 * next call. Every trigger stays active.
 */
export async function convertSavedEventAutomationTriggers(
  db: JuniorDatabase,
  catalog: EventCatalog,
): Promise<{ converted: string[]; kept: string[] }> {
  const converted: string[] = [];
  const kept: string[] = [];
  const tasks = await listEventAutomationsToConvert(db, CONVERSION_BATCH_LIMIT);
  for (const task of tasks) {
    try {
      const conversion = triggerWithoutIdentifier(catalog, task.trigger);
      const saved = await saveEventAutomation(
        db,
        { ...task, trigger: conversion.trigger },
        automationRevision(task),
      );
      if (!saved) continue;
      (conversion.converted ? converted : kept).push(task.id);
      logInfo(
        conversion.converted
          ? "event_automation.trigger.converted"
          : "event_automation.trigger.identifier_kept",
        { "app.task.id": task.id, "app.task.type": "event" },
      );
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
