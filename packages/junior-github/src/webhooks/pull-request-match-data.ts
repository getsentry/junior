import type {
  EventInput,
  EventPublisher,
  PluginLogger,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import type { GitHubDb } from "../db/database.js";
import { gitHubRepoDataSchema } from "../events/scope.js";
import { listGitHubPullRequestOpeners } from "../pull-request-requesters/store.js";
import { definedValues } from "./event-targets.js";
import { isBotLogin } from "./ownership.js";
import type { GitHubPullRequestTarget } from "./pull-request-people.js";

/** A pull request value that needs a database or GitHub call to load. */
type Lookup = "authors" | "opener" | "openerRole";

/** The lookups that each match key needs. */
const LOOKUPS_BY_MATCH_KEY: Record<string, Lookup[]> = {
  authors: ["authors"],
  openerEmail: ["opener"],
  openerRole: ["opener", "openerRole"],
  openerUsername: ["opener"],
};
const ALL_LOOKUPS: Lookup[] = ["authors", "opener", "openerRole"];

/**
 * The values that lookups add to pull request event data. The event data
 * schemas check the rest when the webhook is normalized.
 */
const lookupDataSchema = z
  .object({
    authors: z.array(z.string().min(1)).min(1).optional(),
    openerRole: z.string().min(1).optional(),
    openerUsername: z.string().min(1).optional(),
  })
  .strict();

/** Check the values that lookups found, and drop the missing ones. */
function lookupData(
  input: z.input<typeof lookupDataSchema>,
): Record<string, unknown> {
  return lookupDataSchema.parse(definedValues(input));
}

const webhookSchema = z.object({
  repository: z.object({ full_name: z.string().min(1) }),
});

/** The login whose repository role a lookup reads. */
export interface GitHubRoleTarget {
  login: string;
  repositoryFullName: string;
}

interface LookupContext {
  botEmail: string | undefined;
  db: GitHubDb;
  deliveryId: string;
  loadAuthors?(target: GitHubPullRequestTarget): Promise<string[]>;
  loadGitHubLogin?(identityId: string): Promise<string | undefined>;
  loadRole?(target: GitHubRoleTarget): Promise<string>;
  log?: Pick<PluginLogger, "error">;
  /** Pull request number of each Event key. */
  numbers: Map<string, number>;
  repositoryFullName: string;
}

/**
 * Map each Event key to its pull request number. A pull request Event sets
 * `pullRequest`, and the repository copy has the same key. A check suite
 * result that GitHub links to no pull request, such as on the main branch,
 * has none, so it gets no opener or author values.
 */
function pullRequestNumbers(events: EventInput[]): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const event of events) {
    const number = event.data?.pullRequest;
    if (typeof number === "number") numbers.set(event.eventKey, number);
  }
  return numbers;
}

function logFailure(
  context: LookupContext,
  lookup: string,
  error: unknown,
): undefined {
  context.log?.error(`GitHub pull request ${lookup} lookup failed`, {
    deliveryId: context.deliveryId,
    errorType: error instanceof Error ? error.name : "UnknownError",
    repository: context.repositoryFullName,
  });
  return undefined;
}

/**
 * On a pull request that Junior's bot opened, replace the bot opener with the
 * person who asked Junior to open it, from the saved requester rows. Their
 * GitHub login comes from their user's linked identities when the event
 * arrives, so a later link also applies to older pull requests. With no saved
 * row, no linked login, or a failed lookup, the opener is unknown and the
 * opener fields are left out, so filters on them do not match. The `opened`
 * webhook can arrive before the create tool saves the row.
 */
async function withJuniorOpeners(
  context: LookupContext,
  events: EventInput[],
): Promise<EventInput[]> {
  const botNumber = (event: EventInput) => {
    const number = context.numbers.get(event.eventKey);
    return number !== undefined &&
      isBotLogin(event.data?.openerUsername as string, context.botEmail)
      ? number
      : undefined;
  };
  const numbers = events.flatMap((event) => botNumber(event) ?? []);
  if (numbers.length === 0) return events;
  const openers = await listGitHubPullRequestOpeners(context.db, {
    numbers,
    repositoryFullName: context.repositoryFullName,
  });
  const logins = new Map<string, string | undefined>();
  for (const identityId of new Set(
    [...openers.values()].map((opener) => opener.identityId),
  )) {
    try {
      logins.set(identityId, await context.loadGitHubLogin?.(identityId));
    } catch (error) {
      logFailure(context, "opener", error);
    }
  }
  return events.map((event) => {
    const number = botNumber(event);
    if (number === undefined) return event;
    const identityId = openers.get(number)?.identityId;
    const login = identityId ? logins.get(identityId) : undefined;
    const {
      openerEmail: _email,
      openerUsername: _login,
      ...data
    } = event.data ?? {};
    return {
      ...event,
      data: { ...data, ...lookupData({ openerUsername: login || undefined }) },
    };
  });
}

/**
 * Add `openerRole` and `authors` to pull request events. Each value loads
 * once per delivery. A failed load leaves the value out, so filters on it do
 * not match.
 */
async function withRolesAndAuthors(
  context: LookupContext,
  events: EventInput[],
  lookups: Set<Lookup>,
): Promise<EventInput[]> {
  const { repositoryFullName } = context;
  const roles = new Map<string, Promise<string | undefined>>();
  const authors = new Map<number, Promise<string[] | undefined>>();
  const loadRole = lookups.has("openerRole") ? context.loadRole : undefined;
  const loadAuthors = lookups.has("authors") ? context.loadAuthors : undefined;
  if (!loadRole && !loadAuthors) return events;
  return await Promise.all(
    events.map(async (event) => {
      const number = context.numbers.get(event.eventKey);
      if (number === undefined) return event;
      const login = event.data?.openerUsername;
      if (loadRole && typeof login === "string" && !roles.has(login)) {
        roles.set(
          login,
          loadRole({ login, repositoryFullName }).catch((error: unknown) =>
            logFailure(context, "role", error),
          ),
        );
      }
      if (loadAuthors && !authors.has(number)) {
        authors.set(
          number,
          loadAuthors({ number, repositoryFullName }).catch((error: unknown) =>
            logFailure(context, "authors", error),
          ),
        );
      }
      const role =
        loadRole && typeof login === "string"
          ? await roles.get(login)
          : undefined;
      const logins = loadAuthors ? await authors.get(number) : undefined;
      if (!role && !logins?.length) return event;
      return {
        ...event,
        data: {
          ...event.data,
          ...lookupData({
            authors: logins?.length ? logins : undefined,
            openerRole: role || undefined,
          }),
        },
      };
    }),
  );
}

async function withLookups(
  context: LookupContext,
  events: EventInput[],
  lookups: Set<Lookup>,
): Promise<EventInput[]> {
  // The role is the role of the resolved opener, so openers resolve first.
  const opened = lookups.has("opener")
    ? await withJuniorOpeners(context, events)
    : events;
  return await withRolesAndAuthors(context, opened, lookups);
}

/**
 * Add who opened and who wrote each pull request to its events.
 * `openerUsername` is the GitHub user who opened it, or on Junior's pull
 * requests the person who asked Junior to open it. `openerRole` is that
 * person's repository role. `authors` lists the commit authors and
 * `Co-authored-by` people. These values need database or GitHub calls. They
 * load first when a Watch or event automation filters on them, and the rest
 * load only when an event matches, so the agent sees them all.
 */
export async function withGitHubPullRequestMatchData(args: {
  body: unknown;
  botEmail: string | undefined;
  db: GitHubDb;
  deliveryId: string;
  events: EventInput[];
  hasMatch: EventPublisher["hasMatch"];
  loadAuthors?(target: GitHubPullRequestTarget): Promise<string[]>;
  /** Linked GitHub login of the user of one Junior identity, if any. */
  loadGitHubLogin?(identityId: string): Promise<string | undefined>;
  loadRole?(target: GitHubRoleTarget): Promise<string>;
  log?: Pick<PluginLogger, "error">;
  neededMatchKeys: EventPublisher["neededMatchKeys"];
}): Promise<EventInput[]> {
  const parsed = webhookSchema.safeParse(args.body);
  const numbers = pullRequestNumbers(args.events);
  const pullRequestEvents = args.events.filter((event) =>
    numbers.has(event.eventKey),
  );
  if (!parsed.success || pullRequestEvents.length === 0) return args.events;
  const context: LookupContext = {
    botEmail: args.botEmail,
    db: args.db,
    deliveryId: args.deliveryId,
    ...(args.loadAuthors ? { loadAuthors: args.loadAuthors } : undefined),
    ...(args.loadGitHubLogin
      ? { loadGitHubLogin: args.loadGitHubLogin }
      : undefined),
    ...(args.loadRole ? { loadRole: args.loadRole } : undefined),
    ...(args.log ? { log: args.log } : undefined),
    numbers,
    repositoryFullName: parsed.data.repository.full_name,
  };

  // A match decision needs every value that a filter uses.
  const keys =
    (await args.neededMatchKeys?.({
      // Every copy sets this repo, so a broad trigger for another repo adds
      // no lazy keys.
      data: { repo: gitHubRepoDataSchema.parse(context.repositoryFullName) },
      eventTypes: [...new Set(pullRequestEvents.map((e) => e.eventType))],
      identifiers: [...new Set(pullRequestEvents.map((e) => e.identifier))],
    })) ?? [];
  const filtered = new Set(
    keys.flatMap((key) => LOOKUPS_BY_MATCH_KEY[key] ?? []),
  );
  const events =
    filtered.size > 0
      ? await withLookups(context, args.events, filtered)
      : args.events;

  // Load the other values only for events that reach the agent.
  const rest = new Set(ALL_LOOKUPS.filter((lookup) => !filtered.has(lookup)));
  const { hasMatch } = args;
  if (rest.size === 0 || !hasMatch) return events;
  const matches = await Promise.all(
    events
      .filter((event) => numbers.has(event.eventKey))
      .map((event) => hasMatch(event)),
  );
  if (!matches.some(Boolean)) return events;
  return await withLookups(context, events, rest);
}
