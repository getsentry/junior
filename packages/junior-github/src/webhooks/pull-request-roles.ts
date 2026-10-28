import type {
  EventInput,
  EventPublisher,
  PluginLogger,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { attributedRequesterLogin } from "../tool-support/attribution.js";
import { isBotLogin } from "./ownership.js";

/** Match key for the pull request author's repository role. */
const AUTHOR_ROLE_MATCH_KEY = "authorRole";
/** Match key for the login of the person who asked for the pull request. */
const REQUESTER_USERNAME_MATCH_KEY = "requesterUsername";
/** Match key for the requester's repository role. */
const REQUESTER_ROLE_MATCH_KEY = "requesterRole";

const pullRequestSchema = z.object({
  body: z.string().nullish(),
  user: z.object({ login: z.string().min(1) }).nullish(),
});

// Comment webhooks send the pull request as `issue`.
const webhookSchema = z.object({
  issue: pullRequestSchema.nullish(),
  pull_request: pullRequestSchema.nullish(),
  repository: z.object({ full_name: z.string().min(1) }),
});

/** The login whose repository role a lookup reads. */
export interface GitHubRoleTarget {
  login: string;
  repositoryFullName: string;
}

/**
 * Find the person who asked for a pull request. For a pull request that the
 * Junior bot opened, this is the first linked requester in Junior's
 * attribution block. Otherwise it is the author. Only the Junior bot's own
 * body is trusted, because anyone can write an attribution block.
 */
function pullRequestRequester(
  pullRequest: z.infer<typeof pullRequestSchema> | null | undefined,
  botEmail: string | undefined,
): string | undefined {
  const author = pullRequest?.user?.login.trim();
  if (!author) return undefined;
  if (!isBotLogin(author, botEmail)) return author;
  return attributedRequesterLogin(pullRequest!.body) ?? author;
}

/**
 * Add repository roles to events that name a pull request author.
 * `authorRole` is the author's role. `requesterUsername` and `requesterRole`
 * name the person who asked for the pull request, so a Junior pull request is
 * filtered by its requester instead of by the bot. Requester fields need the
 * pull request in the webhook, so check suite events do not get them.
 * Values load only when a Watch or event automation filters on them. A
 * failed role load leaves the field out, so filters on it do not match.
 */
export async function withGitHubPullRequestRoles(args: {
  body: unknown;
  botEmail: string | undefined;
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
  if (
    authored.length === 0 ||
    !neededMatchKeys ||
    !args.load ||
    !parsed.success
  ) {
    return args.events;
  }
  const keys = await neededMatchKeys({
    eventTypes: [...new Set(authored.map((event) => event.eventType))],
    identifiers: [...new Set(authored.map((event) => event.identifier))],
  });
  const needsAuthorRole = keys.includes(AUTHOR_ROLE_MATCH_KEY);
  const needsRequesterRole = keys.includes(REQUESTER_ROLE_MATCH_KEY);
  const requester =
    needsRequesterRole || keys.includes(REQUESTER_USERNAME_MATCH_KEY)
      ? pullRequestRequester(
          parsed.data.pull_request ?? parsed.data.issue,
          args.botEmail,
        )
      : undefined;
  if (!needsAuthorRole && !requester) return args.events;

  const repositoryFullName = parsed.data.repository.full_name;
  const logins = new Set<string>();
  if (needsAuthorRole) {
    for (const event of authored) {
      logins.add(event.data!.authorUsername as string);
    }
  }
  if (requester && needsRequesterRole) logins.add(requester);
  const roles = new Map<string, string>();
  for (const login of logins) {
    try {
      roles.set(login, await args.load({ login, repositoryFullName }));
    } catch (error) {
      args.log?.error("GitHub pull request role lookup failed", {
        deliveryId: args.deliveryId,
        errorType: error instanceof Error ? error.name : "UnknownError",
        repository: repositoryFullName,
      });
    }
  }
  const requesterRole = requester ? roles.get(requester) : undefined;
  return args.events.map((event) => {
    const login = event.data?.authorUsername;
    if (typeof login !== "string") return event;
    const authorRole = needsAuthorRole ? roles.get(login) : undefined;
    const data = {
      ...event.data,
      ...(authorRole ? { [AUTHOR_ROLE_MATCH_KEY]: authorRole } : undefined),
      ...(requester
        ? { [REQUESTER_USERNAME_MATCH_KEY]: requester }
        : undefined),
      ...(requesterRole
        ? { [REQUESTER_ROLE_MATCH_KEY]: requesterRole }
        : undefined),
    };
    return { ...event, data };
  });
}
