import type {
  EventInput,
  EventPublisher,
  PluginLogger,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import type { GitHubDb } from "../db/database.js";
import { listGitHubPullRequestOpeners } from "../pull-request-requesters/store.js";
import { isBotLogin } from "./ownership.js";

/** Match key for the pull request author's repository role. */
const AUTHOR_ROLE_MATCH_KEY = "authorRole";
/** Match key for the login of the person who asked for the pull request. */
const REQUESTER_USERNAME_MATCH_KEY = "requesterUsername";
/** Match key for the requester's repository role. */
const REQUESTER_ROLE_MATCH_KEY = "requesterRole";

const webhookSchema = z.object({
  pull_request: z
    .object({
      head: z
        .object({
          repo: z
            .object({ full_name: z.string().optional() })
            .nullable()
            .optional(),
        })
        .nullable()
        .optional(),
    })
    .optional(),
  repository: z.object({ full_name: z.string().min(1) }),
});

/** The login whose repository role a lookup reads. */
export interface GitHubRoleTarget {
  login: string;
  repositoryFullName: string;
}

/** Pull request number named by an Event identifier such as `owner/repo#12`. */
function identifierNumber(identifier: string): number | undefined {
  const match = /#(\d+)$/.exec(identifier);
  return match ? Number(match[1]) : undefined;
}

/**
 * Find the person who asked for each pull request in a delivery. On a pull
 * request that Junior's bot opened, this is the person who asked Junior to
 * open it, from the saved requester rows. Otherwise, and when that person has
 * no linked GitHub login, it is the author.
 */
async function pullRequestRequesters(args: {
  botEmail: string | undefined;
  db: GitHubDb;
  deliveryId: string;
  events: EventInput[];
  /** Whether the pull request head is in the base repository, not a fork. */
  headInRepository: boolean;
  loadGitHubLogin?(identityId: string): Promise<string | undefined>;
  log?: Pick<PluginLogger, "error">;
  repositoryFullName: string;
}): Promise<Map<EventInput, string | undefined>> {
  // Repository watches get a copy of each pull request Event with the
  // repository identifier and the same key.
  const numberByEventKey = new Map<string, number>();
  for (const event of args.events) {
    const number = identifierNumber(event.identifier);
    if (number !== undefined) numberByEventKey.set(event.eventKey, number);
  }
  const botPullRequests = args.events.flatMap((event) => {
    const number = numberByEventKey.get(event.eventKey);
    const headBranch = event.data?.headBranch;
    // Only `opened` can arrive before the create tool saves its row. The
    // create tool saves pending rows only for heads in the repository.
    const pendingHeadBranch =
      event.eventType === "pull_request.opened" &&
      args.headInRepository &&
      typeof headBranch === "string"
        ? headBranch
        : undefined;
    if (
      number === undefined ||
      !isBotLogin(event.data!.authorUsername as string, args.botEmail)
    ) {
      return [];
    }
    return [{ number, pendingHeadBranch }];
  });
  const openers = await listGitHubPullRequestOpeners(args.db, {
    pullRequests: botPullRequests,
    repositoryFullName: args.repositoryFullName,
  });
  // The opener's GitHub login comes from their user's linked identities now,
  // not from a copy saved when they asked.
  const logins = new Map<string, string | undefined>();
  const failed = new Set<string>();
  for (const identityId of new Set(openers.values())) {
    try {
      logins.set(identityId, await args.loadGitHubLogin?.(identityId));
    } catch (error) {
      failed.add(identityId);
      args.log?.error("GitHub pull request requester lookup failed", {
        deliveryId: args.deliveryId,
        errorType: error instanceof Error ? error.name : "UnknownError",
        repository: args.repositoryFullName,
      });
    }
  }
  return new Map(
    args.events.map((event) => {
      const number = numberByEventKey.get(event.eventKey);
      const author = event.data!.authorUsername as string;
      const identityId =
        number !== undefined && isBotLogin(author, args.botEmail)
          ? openers.get(number)
          : undefined;
      // A failed lookup leaves the requester out, so filters on it do not
      // match.
      if (identityId && failed.has(identityId)) return [event, undefined];
      return [event, (identityId && logins.get(identityId)) || author];
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
  /** Linked GitHub login of the user of one Junior identity, if any. */
  loadGitHubLogin?(identityId: string): Promise<string | undefined>;
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
        deliveryId: args.deliveryId,
        events: authored,
        ...(args.loadGitHubLogin
          ? { loadGitHubLogin: args.loadGitHubLogin }
          : undefined),
        ...(args.log ? { log: args.log } : undefined),
        headInRepository:
          parsed.data.pull_request?.head?.repo?.full_name?.toLowerCase() ===
          repositoryFullName.toLowerCase(),
        repositoryFullName,
      })
    : new Map<EventInput, string | undefined>();
  const logins = new Set<string>();
  if (needsAuthorRole) {
    for (const event of authored)
      logins.add(event.data!.authorUsername as string);
  }
  if (needsRequesterRole) {
    for (const login of requesters.values()) if (login) logins.add(login);
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
