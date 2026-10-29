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

/** One pull request in a repository. */
export interface GitHubPullRequestTarget {
  number: number;
  repositoryFullName: string;
}

/** The pull request that a people lookup reads. */
export interface GitHubPullRequestPeopleTarget extends GitHubPullRequestTarget {
  /** Pull request opener and assignees from the webhook. */
  logins: string[];
}

/** Loads one page of a pull request's commits from GitHub. */
export type GitHubCommitPageLoader = (
  page: number,
  perPage: number,
) => Promise<unknown>;

/**
 * Share commit page loads within one webhook delivery, so the `authors` field
 * and the people involved read each page once.
 */
export function shareCommitPages(
  load: (target: GitHubPullRequestTarget) => Promise<GitHubCommitPageLoader>,
): (target: GitHubPullRequestTarget) => GitHubCommitPageLoader {
  const loaders = new Map<string, Promise<GitHubCommitPageLoader>>();
  const pages = new Map<string, Promise<unknown>>();
  return (target) => async (page, perPage) => {
    const pullRequest = `${target.repositoryFullName.toLowerCase()}#${target.number}`;
    const key = `${pullRequest}:${page}:${perPage}`;
    let result = pages.get(key);
    if (!result) {
      let loader = loaders.get(pullRequest);
      if (!loader) {
        loader = load(target);
        loaders.set(pullRequest, loader);
      }
      result = loader.then((loadPage) => loadPage(page, perPage));
      pages.set(key, result);
    }
    return await result;
  };
}

/**
 * Call `visit` with the author login and the `Co-authored-by` emails of each
 * commit, for up to `MAX_PAGES` pages of commits.
 */
async function forEachCommit(
  loadPage: GitHubCommitPageLoader,
  visit: (commit: { coAuthorEmails: string[]; login?: string }) => void,
): Promise<void> {
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const commits = commitPageSchema.parse(await loadPage(page, PAGE_SIZE));
    for (const commit of commits) {
      visit({
        coAuthorEmails: [
          ...commit.commit.message.matchAll(CO_AUTHOR_TRAILER),
        ].map((match) => match[1]!.toLowerCase()),
        ...(commit.author ? { login: commit.author.login } : undefined),
      });
    }
    if (commits.length < PAGE_SIZE) break;
  }
}

/** The GitHub login in a noreply email such as `1+octocat@users.noreply.github.com`. */
function noreplyLogin(email: string): string | undefined {
  return GITHUB_NOREPLY_EMAIL.exec(email)?.groups?.login;
}

/**
 * Collect the people involved in a pull request: the webhook logins, commit
 * authors, and `Co-authored-by` trailers. Junior adds a trailer for each
 * person whose instructions a run accepted, so people who steer later are
 * included. Noreply emails become logins. `[bot]` accounts are skipped.
 */
export async function loadGitHubPullRequestPeople(args: {
  logins: readonly string[];
  loadPage: GitHubCommitPageLoader;
}): Promise<EventPerson[]> {
  const people = new Map<string, EventPerson>();
  const addLogin = (login: string) => {
    if (/\[bot\]$/i.test(login)) return;
    const key = `github:${login.toLowerCase()}`;
    if (!people.has(key))
      people.set(key, { provider: "github", handle: login });
  };
  const addEmail = (email: string) => {
    const login = noreplyLogin(email);
    if (login) addLogin(login);
    else if (!people.has(`email:${email}`)) {
      people.set(`email:${email}`, { email });
    }
  };

  args.logins.forEach(addLogin);
  await forEachCommit(args.loadPage, (commit) => {
    if (commit.login) addLogin(commit.login);
    commit.coAuthorEmails.forEach(addEmail);
  });
  return [...people.values()].slice(0, MAX_PEOPLE);
}

/**
 * Collect the GitHub logins of a pull request's commit authors and
 * `Co-authored-by` people, for the `authors` event field. Bots stay in the
 * list, so Junior's own commits name `sentry-junior[bot]` and the people it
 * credits. A co-author without a noreply email has no known login and is
 * left out.
 */
export async function loadGitHubPullRequestAuthors(args: {
  loadPage: GitHubCommitPageLoader;
}): Promise<string[]> {
  const authors = new Map<string, string>();
  const add = (login: string | undefined) => {
    if (login && !authors.has(login.toLowerCase())) {
      authors.set(login.toLowerCase(), login);
    }
  };
  await forEachCommit(args.loadPage, (commit) => {
    add(commit.login);
    commit.coAuthorEmails.forEach((email) => add(noreplyLogin(email)));
  });
  return [...authors.values()].slice(0, MAX_PEOPLE);
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
