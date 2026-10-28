import type {
  EventInput,
  EventPerson,
  EventPublisher,
  PluginLogger,
} from "@sentry/junior-plugin-api";
import { z } from "zod";

/** Pull request outcomes that the people involved need to hear about. */
const PEOPLE_EVENTS = new Set([
  "pull_request.review.approved",
  "pull_request.merged",
]);
const MAX_PEOPLE = 20;
const PAGE_SIZE = 100;
const MAX_PAGES = 3;
const CO_AUTHOR_TRAILER = /^co-authored-by:[^<\n]*<([^>\s]+@[^>\s]+)>\s*$/gim;
const GITHUB_NOREPLY_EMAIL =
  /^(?:\d+\+)?(?<login>[^@+]+)@users\.noreply\.github\.com$/i;

const webhookSchema = z.object({
  pull_request: z.object({
    assignees: z.array(z.object({ login: z.string().min(1) })).nullish(),
    number: z.number(),
    user: z.object({ login: z.string().min(1) }).nullish(),
  }),
  repository: z.object({ full_name: z.string().min(1) }),
});

const commitPageSchema = z.array(
  z.object({
    author: z.object({ login: z.string().min(1) }).nullish(),
    commit: z.object({ message: z.string() }),
  }),
);

/** The pull request that a people lookup reads. */
export interface GitHubPullRequestPeopleTarget {
  /** Pull request author and assignees from the webhook. */
  logins: string[];
  number: number;
  repositoryFullName: string;
}

/**
 * Collect the people involved in a pull request: the webhook logins, commit
 * authors, and `Co-authored-by` trailers. Junior adds a trailer for each
 * person whose instructions a run accepted, so people who steer later are
 * included. Noreply emails become logins. `[bot]` accounts are skipped.
 */
export async function loadGitHubPullRequestPeople(args: {
  logins: readonly string[];
  loadPage(page: number, perPage: number): Promise<unknown>;
}): Promise<EventPerson[]> {
  const people = new Map<string, EventPerson>();
  const addLogin = (login: string) => {
    if (/\[bot\]$/i.test(login)) return;
    const key = `github:${login.toLowerCase()}`;
    if (!people.has(key))
      people.set(key, { provider: "github", handle: login });
  };
  const addEmail = (value: string) => {
    const email = value.toLowerCase();
    const login = GITHUB_NOREPLY_EMAIL.exec(email)?.groups?.login;
    if (login) addLogin(login);
    else if (!people.has(`email:${email}`)) {
      people.set(`email:${email}`, { email });
    }
  };

  args.logins.forEach(addLogin);
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const commits = commitPageSchema.parse(
      await args.loadPage(page, PAGE_SIZE),
    );
    for (const commit of commits) {
      if (commit.author) addLogin(commit.author.login);
      for (const match of commit.commit.message.matchAll(CO_AUTHOR_TRAILER)) {
        addEmail(match[1]!);
      }
    }
    if (commits.length < PAGE_SIZE) break;
  }
  return [...people.values()].slice(0, MAX_PEOPLE);
}

/**
 * Add the people involved to approval and merge events. It loads them only
 * when a Watch or event automation matches, so other deliveries make no extra
 * GitHub calls. People only add context, so a failed load keeps the events.
 */
export async function withGitHubPullRequestPeople(args: {
  body: unknown;
  deliveryId: string;
  events: EventInput[];
  hasMatch: EventPublisher["hasMatch"];
  load?(target: GitHubPullRequestPeopleTarget): Promise<EventPerson[]>;
  log?: Pick<PluginLogger, "error">;
}): Promise<EventInput[]> {
  const { hasMatch } = args;
  const peopleEvents = args.events.filter((event) =>
    PEOPLE_EVENTS.has(event.eventType),
  );
  const parsed = webhookSchema.safeParse(args.body);
  if (peopleEvents.length === 0 || !hasMatch || !args.load || !parsed.success) {
    return args.events;
  }
  const matches = await Promise.all(
    peopleEvents.map((event) => hasMatch(event)),
  );
  if (!matches.some(Boolean)) return args.events;

  const { pull_request: pullRequest, repository } = parsed.data;
  const target = {
    logins: [
      ...(pullRequest.user ? [pullRequest.user.login] : []),
      ...(pullRequest.assignees ?? []).map((assignee) => assignee.login),
    ],
    number: pullRequest.number,
    repositoryFullName: repository.full_name,
  };
  let people: EventPerson[];
  try {
    people = await args.load(target);
  } catch (error) {
    args.log?.error("GitHub pull request people lookup failed", {
      deliveryId: args.deliveryId,
      errorType: error instanceof Error ? error.name : "UnknownError",
      number: target.number,
      repository: target.repositoryFullName,
    });
    return args.events;
  }
  if (people.length === 0) return args.events;
  return args.events.map((event) =>
    PEOPLE_EVENTS.has(event.eventType) ? { ...event, people } : event,
  );
}
