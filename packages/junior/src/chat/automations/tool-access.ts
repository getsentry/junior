/** Automation access for the Automation tools. */
import type { Identity, User } from "@sentry/junior-plugin-api";
import { z } from "zod";
import { automationListQuerySchema } from "@/api/schema/automation";
import { isUserActor, type UserActor } from "@/chat/actor";
import { getDb } from "@/chat/db";
import { createPluginAnnotations } from "@/chat/plugins/annotations";
import { sanitizeScheduledAutomationPrincipal } from "@/chat/scheduled-automations/identity";
import type { ScheduledAutomationPrincipal } from "@/chat/scheduled-automations/types";
import { getSlackToolContext } from "@/chat/slack/tool-support/context";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import {
  destinationFilterValue,
  type AutomationDestination,
  type AutomationViewer,
} from "./creator";
import { readAutomationCollection } from "./collection";
import { deleteAutomation } from "./edit";
import {
  readTaskCandidates,
  resolveViewerTaskCandidate,
  type TaskCandidate,
} from "./read";

type ResolvedActor = { identity: Identity; user?: User };

/** The person and the Conversation of one Automation tool call. */
export interface AutomationToolContext {
  conversationId: string;
  /** The person who started this Turn. Unset when no person started it. */
  actor?: UserActor;
  /**
   * Destination of the Conversation Location. Unset when the Conversation has
   * no Location that an Automation can deliver to.
   */
  destination?: AutomationDestination;
  /** Conversation visibility. A new or moved Automation stores it. */
  visibility?: "public" | "private";
  now?: () => number;
  users: { resolveActor(): Promise<ResolvedActor | undefined> };
  userText?: string;
}

/** The person who calls an Automation tool, with what they can manage. */
export interface AutomationToolCaller {
  actor: UserActor;
  resolved?: ResolvedActor;
  viewer: AutomationViewer;
}

/**
 * Return the Actor when that person started this Turn from any surface.
 * Automation runs, Events, plugin dispatch, and Agent invocations act for no
 * person, so they cannot manage Automations.
 */
function personActor(context: ToolRuntimeContext): UserActor | undefined {
  const { actor, source } = context;
  if (!isUserActor(actor) || actor.platform !== source.kind) return undefined;
  const otherWorkspace =
    actor.platform === "slack" &&
    source.kind === "slack" &&
    actor.teamId !== source.teamId;
  return otherWorkspace ? undefined : actor;
}

/** Disable reason for the Automation tools in a Turn that no person started. */
export function automationToolsDisabledReason(
  context: ToolRuntimeContext,
): string | undefined {
  return personActor(context)
    ? undefined
    : "It needs a Turn that a person started.";
}

/**
 * Build the Automation tool context for this Turn. Automations deliver to a
 * channel or DM, so a thread Location gives its channel.
 */
export function automationToolContext(
  context: ToolRuntimeContext,
): AutomationToolContext {
  const actor = personActor(context);
  // TODO(dcramer): Read `context.location` directly after every Conversation
  // that came from Slack has a stored Location.
  const location = getSlackToolContext(context);
  const { source } = context;
  return {
    conversationId: context.conversationId,
    ...(actor ? { actor } : undefined),
    ...(location
      ? {
          destination: {
            platform: "slack",
            teamId: location.teamId,
            channelId: location.locationChannelId,
          },
        }
      : undefined),
    ...("visibility" in source ? { visibility: source.visibility } : undefined),
    users: {
      resolveActor: context.resolveActorIdentity ?? (async () => undefined),
    },
    ...(context.userText ? { userText: context.userText } : undefined),
  };
}

/** The account of the Actor. It counts also when no Identity is stored. */
function actorAccount(actor: UserActor) {
  return {
    provider: actor.platform,
    providerSubjectId: actor.userId,
    ...(actor.platform === "slack"
      ? { providerTenantId: actor.teamId }
      : undefined),
    ...(actor.fullName ? { displayName: actor.fullName } : undefined),
    ...(actor.userName ? { handle: actor.userName } : undefined),
  };
}

function storedIdentities(resolved: ResolvedActor | undefined): Identity[] {
  return resolved?.user?.identities ?? (resolved ? [resolved.identity] : []);
}

/**
 * Resolve the person who calls an Automation tool. They manage Automations
 * with the dashboard rule, and also the Automations that deliver to the
 * Location of this Conversation.
 */
export async function requireToolCaller(
  context: AutomationToolContext,
): Promise<AutomationToolCaller> {
  const actor = context.actor;
  if (!actor || actor.userId.trim().toLowerCase() === "unknown") {
    throw new ToolInputError(
      "Automation tools need a Turn that a person started.",
    );
  }
  const resolved = await context.users.resolveActor();
  return {
    actor,
    ...(resolved ? { resolved } : undefined),
    viewer: {
      // The Actor account comes first. It has the name that the person uses
      // now, which an edit records and checks in the instruction.
      identities: [actorAccount(actor), ...storedIdentities(resolved)],
      ...(context.destination ? { location: context.destination } : undefined),
    },
  };
}

/** Require the Destination of this Conversation for a new or moved Automation. */
export function requireToolDestination(
  context: AutomationToolContext,
): AutomationDestination {
  if (!context.destination) {
    throw new ToolInputError(
      "This Conversation has no channel or DM that an Automation can deliver to. Ask from the channel or DM where it should deliver.",
    );
  }
  return context.destination;
}

/**
 * Return the creator of a new Automation. It is the caller's stored Identity
 * in the provider and workspace of the Destination, because the Automation
 * stores its creator as an account there.
 */
export function requireToolCreator(
  caller: AutomationToolCaller,
  destination: AutomationDestination,
  kind: TaskCandidate["kind"],
): { identity: Identity; createdBy: ScheduledAutomationPrincipal } {
  const matches = (identity: Identity) =>
    identity.provider === destination.platform &&
    identity.providerTenantId === destination.teamId;
  const identity = [
    caller.resolved?.identity,
    ...storedIdentities(caller.resolved),
  ].find((candidate) => candidate && matches(candidate));
  if (!identity) {
    throw new ToolInputError(
      `${kind === "scheduled" ? "Scheduled" : "Event"} automation creator identity is unavailable.`,
    );
  }
  const { actor } = caller;
  const fullName = actor.fullName ?? identity.displayName;
  const userName = actor.userName ?? identity.handle;
  return {
    identity,
    createdBy: sanitizeScheduledAutomationPrincipal({
      slackUserId: identity.providerSubjectId,
      ...(fullName ? { fullName } : undefined),
      ...(userName ? { userName } : undefined),
    }),
  };
}

const NOT_FOUND =
  "Automation was not found. Automations in private channels and DMs can be managed only from there or by their creator.";

/** Load one Automation that the tool caller can manage. */
export async function requireToolAutomation(
  caller: AutomationToolCaller,
  id: string,
): Promise<TaskCandidate> {
  const candidate = await resolveViewerTaskCandidate(caller.viewer, id);
  if (!candidate) throw new ToolInputError(NOT_FOUND);
  return candidate;
}

/** Delete an Automation for a tool and remove its card from the Conversation. */
export async function deleteToolAutomation(
  conversationId: string,
  current: TaskCandidate,
): Promise<TaskCandidate> {
  const deleted = await deleteAutomation(current);
  if (!deleted) throw new ToolInputError(NOT_FOUND);
  await createPluginAnnotations({
    conversationId,
    db: getDb(),
    plugin: "junior",
  }).remove("object", current.task.id);
  return deleted;
}

const MAX_SEARCHED_AUTOMATIONS = 50;

/** Model-facing input of the Automation search tool. */
export const automationSearchInputSchema = z
  .object({
    type: z
      .enum(["scheduled", "event"])
      .nullable()
      .describe(
        "scheduled: only automations with a schedule. event: only automations that run on events. Omit to find both.",
      )
      .optional(),
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .nullable()
      .describe(
        "Text in the title or instruction, an automation ID, or a dashboard URL.",
      )
      .optional(),
    scope: z
      .enum(["all", "current_conversation", "mine"])
      .nullable()
      .describe(
        "Omit to search everything the requester can find. Set current_conversation (only automations that deliver to this conversation) or mine (only automations the requester created) only when the user limits the search that way.",
      )
      .optional(),
    destination: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .nullable()
      .describe(
        "Limit results to automations that deliver to this destination. Use destination.id from an earlier result.",
      )
      .optional(),
  })
  .strict();

/**
 * Search Automations with the dashboard Automations search, as the tool
 * caller sees them. Returns them in search order.
 */
export async function searchToolAutomations(
  context: AutomationToolContext,
  caller: AutomationToolCaller,
  input: z.output<typeof automationSearchInputSchema>,
): Promise<{ automations: TaskCandidate[]; truncated: boolean }> {
  let destination = input.destination ?? undefined;
  if (input.scope === "current_conversation") {
    const here = destinationFilterValue(requireToolDestination(context));
    if (destination && destination !== here) {
      throw new ToolInputError(
        'Use scope "current_conversation" or destination, not both.',
      );
    }
    destination = here;
  }
  const { rows, total } = await readAutomationCollection(
    caller.viewer,
    automationListQuerySchema.parse({
      q: input.query ?? undefined,
      scope: input.scope === "mine" ? "mine" : "all",
      type: input.type ?? "all",
      destination,
      pageSize: MAX_SEARCHED_AUTOMATIONS,
    }),
  );
  return {
    automations: await readTaskCandidates(
      caller.viewer,
      rows.map((row) => row.id),
    ),
    truncated: total > rows.length,
  };
}
