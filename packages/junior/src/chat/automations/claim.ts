/**
 * Claim: a person who can manage an Automation becomes its creator. They
 * manage it as its creator, and runs name and notify them. A claim never
 * moves one person's credentials to another, so it always switches to system
 * credentials.
 */
import type { TaskOutcome } from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { saveEventAutomation } from "@/chat/event-automations/store";
import { logAudit } from "@/chat/logging";
import { saveScheduledAutomation } from "@/chat/scheduled-automations/tasks";
import type { ScheduledAutomationPrincipal } from "@/chat/scheduled-automations/types";
import { openSlackDirectMessage } from "@/chat/slack/outbound";
import { AutomationEditError } from "./edit-rules";
import { ViewerTaskNotFoundError, type TaskCandidate } from "./read";
import { requireAutomationRevision } from "./revision";

/** The person who claims, as the Automation stores its creator. */
type AutomationClaimer = {
  identityId: string;
  createdBy: ScheduledAutomationPrincipal;
};

/**
 * Send the messages that went to the previous creator's DM to the claimer's
 * DM. A message to the creator follows the creator, so the previous creator
 * stops getting results of work they no longer own.
 */
async function claimOutcomes(
  current: TaskCandidate,
  claimer: AutomationClaimer,
): Promise<TaskOutcome[]> {
  const { task } = current;
  const { teamId } = task.destination;
  let previousDm: string | undefined;
  let claimerDm: string | undefined;
  const outcomes: TaskOutcome[] = [];
  for (const outcome of task.outcomes) {
    const target = outcome.destination;
    if (
      target.teamId !== teamId ||
      target.channelId === task.destination.channelId
    ) {
      outcomes.push(outcome);
      continue;
    }
    previousDm ??= await openSlackDirectMessage(task.createdBy.slackUserId);
    if (target.channelId !== previousDm) {
      outcomes.push(outcome);
      continue;
    }
    claimerDm ??= await openSlackDirectMessage(claimer.createdBy.slackUserId);
    outcomes.push({
      ...outcome,
      destination: { platform: "slack", teamId, channelId: claimerDm },
    });
  }
  return outcomes;
}

/**
 * Make the claimer the creator of an Automation that they can manage, with
 * system credentials. Status stays as it is, so paused or blocked work
 * starts only after a resume. Claiming your own Automation changes nothing.
 */
export async function claimAutomation(
  current: TaskCandidate,
  claimer: AutomationClaimer,
  revision: string,
): Promise<TaskCandidate> {
  requireAutomationRevision(current.task, revision);
  if (current.ownedByViewer) return current;
  if (current.task.status === "completed")
    throw new AutomationEditError("Completed Automations cannot be claimed.");
  const previousCreator = current.task.createdBy.slackUserId;
  const claimed = {
    creatorIdentityId: claimer.identityId,
    createdBy: claimer.createdBy,
    credentialMode: "system" as const,
    outcomes: await claimOutcomes(current, claimer),
  };
  let next: TaskCandidate;
  if (current.kind === "scheduled") {
    const task = await saveScheduledAutomation(
      getDb(),
      { ...current.task, ...claimed, updatedAtMs: Date.now() },
      revision,
      claimer.createdBy,
    );
    next = { kind: "scheduled", task, ownedByViewer: true };
  } else {
    const task = await saveEventAutomation(
      getDb(),
      { ...current.task, ...claimed },
      revision,
      claimer.createdBy,
    );
    if (!task) throw new ViewerTaskNotFoundError();
    next = { kind: "event", task, ownedByViewer: true };
  }
  logAudit("automation.claim.completed", {
    "user.id": claimer.createdBy.slackUserId,
    "app.task.id": next.task.id,
    "app.task.type": next.kind,
    "app.task.previous_creator.id": previousCreator,
  });
  return next;
}
