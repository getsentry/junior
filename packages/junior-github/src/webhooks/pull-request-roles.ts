import type {
  EventInput,
  EventPublisher,
  PluginLogger,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import type { GitHubDb } from "../db/database.js";
import { listGitHubPullRequestRequesters } from "../pull-request-requesters/store.js";
import { isBotLogin } from "./ownership.js";

/** Match key for the pull request author's repository role. */
const AUTHOR_ROLE_MATCH_KEY = "authorRole";
/** Match key for the login of the person who asked for the pull request. */
const REQUESTER_USERNAME_MATCH_KEY = "requesterUsername";
/** Match key for the requester's repository role. */
const REQUESTER_ROLE_MATCH_KEY = "requesterRole";

const webhookSchema = z.object({
  repository: z.object({ full_name: z.string().min(1) }),
});

/** The login whose repository role a lookup reads. */
export interface GitHubRoleTarget {
  login: string;
  repositoryFullName: string;
}

/**
 * Find the person who asked for each pull request in a delivery. On a pull
 * request that Junior's bot opened, this is the linked requester that the
 * create tool saved for the head branch. Otherwise, and when Junior has no
 * saved requester, it is the author. Events without `headBranch`, such as
 * conversation comments, cannot use the saved requester.
 */
async function pullRequestRequesters(args: {
  botEmail: string | undefined;
  db: GitHubDb;
  events: EventInput[];
  repositoryFullName: string;
}): Promise<Map<EventInput, string>> {
  const savedBranch = (event: EventInput) =>
    isBotLogin(event.data!.authorUsername as string, args.botEmail) &&
    typeof event.data?.headBranch === "string"
      ? event.data.headBranch
      : undefined;
  const saved = await listGitHubPullRequestRequesters(args.db, {
    headBranches: args.events.flatMap((event) => savedBranch(event) ?? []),
    repositoryFullName: args.repositoryFullName,
  });
  return new Map(
    args.events.map((event) => {
      const branch = savedBranch(event);
      const requester = branch ? saved.get(branch) : undefined;
      return [event, requester ?? (event.data!.authorUsername as string)];
    }),
  );
}

/**
 * Add repository roles to events that name a pull request author.
 * `authorRole` is the author's role. `requesterUsername` and `requesterRole`
 * name the person who asked for the pull request, so a Junior pull request is
 * filtered by its requester instead of by the bot. Values load only when a
 * Watch or event automation filters on them. A failed role load leaves the
 * role out, so filters on it do not match.
 */
export async function withGitHubPullRequestRoles(args: {
  body: unknown;
  botEmail: string | undefined;
  db: GitHubDb;
  deliveryId: string;
  events: EventInput[];
  load?(target: GitHubRoleTarget): Promise<string>;
  log?: Pick<PluginLogger, "error">;
  neededMatchKeys: EventPublisher["neededMatchKeys"];
}): Promise<EventInput[]> {
  const { neededMatchKeys } = args;
  const authored = args.events.filter(
    (event) => typeof event.data?.authorUsername === "string",
  );
  const parsed = webhookSchema.safeParse(args.body);
  if (authored.length === 0 || !neededMatchKeys || !parsed.success) {
    return args.events;
  }
  const keys = await neededMatchKeys({
    eventTypes: [...new Set(authored.map((event) => event.eventType))],
    identifiers: [...new Set(authored.map((event) => event.identifier))],
  });
  const needsAuthorRole =
    Boolean(args.load) && keys.includes(AUTHOR_ROLE_MATCH_KEY);
  const needsRequesterRole =
    Boolean(args.load) && keys.includes(REQUESTER_ROLE_MATCH_KEY);
  const needsRequester =
    needsRequesterRole || keys.includes(REQUESTER_USERNAME_MATCH_KEY);
  if (!needsAuthorRole && !needsRequester) return args.events;

  const repositoryFullName = parsed.data.repository.full_name;
  const requesters = needsRequester
    ? await pullRequestRequesters({
        botEmail: args.botEmail,
        db: args.db,
        events: authored,
        repositoryFullName,
      })
    : new Map<EventInput, string>();
  const logins = new Set<string>();
  if (needsAuthorRole) {
    for (const event of authored)
      logins.add(event.data!.authorUsername as string);
  }
  if (needsRequesterRole) {
    for (const login of requesters.values()) logins.add(login);
  }
  const roles = new Map<string, string>();
  for (const login of logins) {
    try {
      roles.set(login, await args.load!({ login, repositoryFullName }));
    } catch (error) {
      args.log?.error("GitHub pull request role lookup failed", {
        deliveryId: args.deliveryId,
        errorType: error instanceof Error ? error.name : "UnknownError",
        repository: repositoryFullName,
      });
    }
  }
  return args.events.map((event) => {
    const author = event.data?.authorUsername;
    if (typeof author !== "string") return event;
    const authorRole = needsAuthorRole ? roles.get(author) : undefined;
    const requester = requesters.get(event);
    const requesterRole =
      needsRequesterRole && requester ? roles.get(requester) : undefined;
    return {
      ...event,
      data: {
        ...event.data,
        ...(authorRole ? { [AUTHOR_ROLE_MATCH_KEY]: authorRole } : undefined),
        ...(requester
          ? { [REQUESTER_USERNAME_MATCH_KEY]: requester }
          : undefined),
        ...(requesterRole
          ? { [REQUESTER_ROLE_MATCH_KEY]: requesterRole }
          : undefined),
      },
    };
  });
}
