import type { EventInput, EventPerson } from "@sentry/junior-plugin-api";
import { z } from "zod";

/**
 * Pull request events that tell the people involved about an outcome. Only
 * these events load people, so other events make no extra GitHub calls.
 */
export const GITHUB_PULL_REQUEST_PEOPLE_EVENTS: ReadonlySet<string> = new Set([
  "pull_request.review.approved",
  "pull_request.merged",
]);

const MAX_PEOPLE = 20;
const PAGE_SIZE = 100;
const MAX_PAGES = 3;

const pullRequestPeopleWebhookSchema = z.object({
  pull_request: z.object({
    assignees: z
      .array(z.object({ login: z.string().min(1) }).passthrough())
      .optional()
      .nullable(),
    number: z.number(),
    user: z
      .object({ login: z.string().min(1) })
      .passthrough()
      .optional()
      .nullable(),
  }),
  repository: z.object({ full_name: z.string().min(1) }),
});

const commitPageSchema = z.array(
  z
    .object({
      author: z
        .object({ login: z.string().min(1) })
        .passthrough()
        .nullable()
        .optional(),
      commit: z.object({ message: z.string() }).passthrough(),
    })
    .passthrough(),
);

/** Pull request facts from the webhook that people loading needs. */
export interface GitHubPullRequestPeopleTarget {
  /** Pull request author first, then assignees. */
  logins: string[];
  number: number;
  repositoryFullName: string;
}

/** Read the pull request and its people from a PR or review webhook body. */
export function gitHubPullRequestPeopleTarget(
  body: unknown,
): GitHubPullRequestPeopleTarget | undefined {
  const parsed = pullRequestPeopleWebhookSchema.safeParse(body);
  if (!parsed.success) return undefined;
  const author = parsed.data.pull_request.user?.login;
  return {
    logins: [
      ...(author ? [author] : []),
      ...(parsed.data.pull_request.assignees ?? []).map(
        (assignee) => assignee.login,
      ),
    ],
    number: parsed.data.pull_request.number,
    repositoryFullName: parsed.data.repository.full_name,
  };
}

const CO_AUTHOR_TRAILER = /^co-authored-by:[^<\n]*<([^>\s]+@[^>\s]+)>\s*$/gim;
const GITHUB_NOREPLY_EMAIL =
  /^(?:\d+\+)?(?<login>[^@+]+)@users\.noreply\.github\.com$/i;

/** Return the email of each `Co-authored-by` trailer in a commit message. */
export function coAuthorEmails(message: string): string[] {
  return [...message.matchAll(CO_AUTHOR_TRAILER)].map((match) => match[1]!);
}

/**
 * Collect the people involved in a pull request: the webhook logins, commit
 * authors, and the co-authors that commit trailers name. Junior adds a trailer
 * for each person whose instructions a run accepted, so people who steer later
 * are included.
 * GitHub noreply emails become GitHub logins. App accounts are skipped.
 */
export async function loadGitHubPullRequestPeople(args: {
  logins: readonly string[];
  loadPage(page: number, perPage: number): Promise<unknown>;
}): Promise<EventPerson[]> {
  const people: EventPerson[] = [];
  const seen = new Set<string>();
  const addLogin = (login: string) => {
    // App accounts, such as Junior or Dependabot, are not people.
    if (/\[bot\]$/i.test(login)) return;
    const key = `github:${login.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    people.push({ provider: "github", handle: login });
  };
  const addEmail = (value: string) => {
    const email = value.trim().toLowerCase();
    const login = GITHUB_NOREPLY_EMAIL.exec(email)?.groups?.login;
    if (login) {
      addLogin(login);
      return;
    }
    const key = `email:${email}`;
    if (seen.has(key)) return;
    seen.add(key);
    people.push({ email });
  };

  for (const login of args.logins) addLogin(login);
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const commits = commitPageSchema.parse(
      await args.loadPage(page, PAGE_SIZE),
    );
    for (const commit of commits) {
      if (commit.author) addLogin(commit.author.login);
      for (const email of coAuthorEmails(commit.commit.message)) {
        addEmail(email);
      }
    }
    if (commits.length < PAGE_SIZE) break;
  }
  return people.slice(0, MAX_PEOPLE);
}

/** Add people to the outcome events that need them. Other events are unchanged. */
export function withGitHubPullRequestPeople(
  events: EventInput[],
  people: EventPerson[],
): EventInput[] {
  if (people.length === 0) return events;
  return events.map((event) =>
    GITHUB_PULL_REQUEST_PEOPLE_EVENTS.has(event.eventType)
      ? { ...event, people }
      : event,
  );
}
