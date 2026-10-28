import type {
  EventInput,
  EventPublisher,
  PluginLogger,
} from "@sentry/junior-plugin-api";
import { z } from "zod";

/** Match key for the pull request author's repository role. */
const AUTHOR_ROLE_MATCH_KEY = "authorRole";

const webhookSchema = z.object({
  repository: z.object({ full_name: z.string().min(1) }),
});

/** The author whose repository role a lookup reads. */
export interface GitHubAuthorRoleTarget {
  login: string;
  repositoryFullName: string;
}

/**
 * Add the author's repository role to events that name a pull request author.
 * It loads the role only when a Watch or event automation filters on
 * `authorRole`, so other deliveries make no extra GitHub calls. A failed load
 * leaves the field out, so filters on it do not match.
 */
export async function withGitHubPullRequestAuthorRole(args: {
  body: unknown;
  deliveryId: string;
  events: EventInput[];
  load?(target: GitHubAuthorRoleTarget): Promise<string>;
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
  if (!keys.includes(AUTHOR_ROLE_MATCH_KEY)) return args.events;

  const repositoryFullName = parsed.data.repository.full_name;
  const logins = new Set(
    authored.map((event) => event.data!.authorUsername as string),
  );
  const roles = new Map<string, string>();
  for (const login of logins) {
    try {
      roles.set(login, await args.load({ login, repositoryFullName }));
    } catch (error) {
      args.log?.error("GitHub pull request author role lookup failed", {
        deliveryId: args.deliveryId,
        errorType: error instanceof Error ? error.name : "UnknownError",
        repository: repositoryFullName,
      });
    }
  }
  return args.events.map((event) => {
    const login = event.data?.authorUsername;
    const role = typeof login === "string" ? roles.get(login) : undefined;
    return role
      ? { ...event, data: { ...event.data, [AUTHOR_ROLE_MATCH_KEY]: role } }
      : event;
  });
}
