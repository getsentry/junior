/**
 * The core link type of dashboard Automation links. An Automation card
 * reads the Automation live with the access rule of the Automations view,
 * so an Annotation of an Automation stores only its title and its link.
 */
import {
  eventTriggerText,
  type ObjectAnnotation,
  type User,
} from "@sentry/junior-plugin-api";
import type { AutomationSummary } from "@/api/schema/automation";
import {
  readViewerAutomationSummary,
  resolveViewerTaskCandidate,
} from "@/chat/automations/read";
import { automationCardStatus } from "@/chat/automations/card";
import { automationTaskDescription } from "@/chat/automations/task";
import {
  getDashboardTaskLink,
  parseDashboardTaskLink,
} from "@/chat/dashboard-link";

function automationObjectCard(
  automation: AutomationSummary,
  url: string,
): ObjectAnnotation {
  const { status, warning } = automationCardStatus({
    status: automation.status,
    statusReason: automation.statusReason,
    triggerProblems:
      automation.kind === "event" ? automation.trigger.problems : undefined,
  });
  const title = automation.title.slice(0, 512);
  // Only the card notes completion. Slack details show it as the status.
  const note =
    warning ??
    (status === "completed" ? "This automation has completed." : undefined);
  return {
    kind: "object",
    objectType: "automation",
    key: automation.id,
    label: title.slice(0, 256),
    title,
    url,
    description: automationTaskDescription(automation.task).slice(0, 4000),
    status,
    trigger: (automation.kind === "scheduled"
      ? automation.schedule
      : eventTriggerText(automation.resource, automation.trigger)
    ).slice(0, 4000),
    ...(note ? { warning: note.slice(0, 1000) } : undefined),
  };
}

/** Return whether the viewer may see the linked Automation. */
export async function canViewAutomationLink(
  viewer: User,
  url: URL,
): Promise<boolean> {
  const id = parseDashboardTaskLink(url.href);
  return Boolean(id && (await resolveViewerTaskCandidate(viewer, id)));
}

/** Read the card of a linked Automation that the viewer may see. */
export async function resolveAutomationLink(
  viewer: User,
  url: URL,
): Promise<ObjectAnnotation | undefined> {
  const id = parseDashboardTaskLink(url.href);
  const link = id && getDashboardTaskLink(id);
  const automation = link && (await readViewerAutomationSummary(viewer, id));
  return automation ? automationObjectCard(automation, link) : undefined;
}
