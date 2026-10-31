/** Automation access for the scheduled and event automation tools. */
import type {
  Identity,
  SlackDestination,
  User,
} from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { createPluginAnnotations } from "@/chat/plugins/annotations";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { AutomationViewer } from "./creator";
import { deleteAutomation } from "./edit";
import { resolveViewerTaskCandidate, type TaskCandidate } from "./read";

type ToolAutomation<K extends TaskCandidate["kind"]> = Extract<
  TaskCandidate,
  { kind: K }
>;

/**
 * Build the viewer for a tool call by one Slack user in one Slack channel. A
 * Slack person with no linked Junior user still has their stored Slack
 * identity.
 */
export function slackToolViewer(
  resolved: { identity: Identity; user?: User } | undefined,
  channel: SlackDestination,
  slackUserId: string,
): AutomationViewer {
  return {
    identities:
      resolved?.user?.identities ?? (resolved ? [resolved.identity] : []),
    channel,
    slackUserId,
  };
}

function notFound(kind: TaskCandidate["kind"]): ToolInputError {
  return new ToolInputError(
    `${kind === "scheduled" ? "Scheduled" : "Event"} automation was not found. Automations in private channels and DMs can be managed only from there or by their creator.`,
  );
}

/** Load one Automation of this kind that the tool caller can manage. */
export async function requireToolAutomation<K extends TaskCandidate["kind"]>(
  viewer: AutomationViewer,
  kind: K,
  id: string,
): Promise<ToolAutomation<K>> {
  const candidate = await resolveViewerTaskCandidate(viewer, id);
  if (candidate?.kind !== kind) throw notFound(kind);
  return candidate as ToolAutomation<K>;
}

/** Delete an Automation for a tool and remove its card from the Conversation. */
export async function deleteToolAutomation<K extends TaskCandidate["kind"]>(
  conversationId: string,
  current: ToolAutomation<K>,
): Promise<ToolAutomation<K>["task"]> {
  const deleted = await deleteAutomation(current);
  if (!deleted) throw notFound(current.kind);
  await createPluginAnnotations({
    conversationId,
    db: getDb(),
    plugin: "junior",
  }).remove("object", current.task.id);
  return deleted.task as ToolAutomation<K>["task"];
}
