import { eventMatches, type EventInput } from "@sentry/junior-plugin-api";
import {
  filterEventMismatches,
  identifierMatchMismatches,
} from "@sentry/junior-testing/event-filters";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { githubPlugin } from "../src/index";
import type { GitHubDb } from "../src/db/database";
import { normalizeGitHubEvents } from "../src/webhooks/events";
import { withGitHubPullRequestMatchData } from "../src/webhooks/pull-request-match-data";
import { createGitHubFixture, type GitHubFixture } from "./github-db";

let dbFixture: GitHubFixture;
let db: GitHubDb;

beforeAll(async () => {
  dbFixture = await createGitHubFixture();
  db = dbFixture.db();
});

afterAll(async () => {
  await dbFixture.close();
});

const opener = { email: "dcramer@example.com", login: "dcramer" };

/** The values that one set of fixture deliveries uses. */
interface FixtureScope {
  checkSha: string;
  deploymentId: number;
  deploymentSha: string;
  environment: string;
  issue: number;
  pullRequest: number;
  repo: string;
  tag: string;
}

// Mixed case, to show that scope values are lowercase like identifiers.
const BASE_SCOPE: FixtureScope = {
  checkSha: "B".repeat(40),
  deploymentId: 3001,
  deploymentSha: "A".repeat(40),
  environment: "Production",
  issue: 12,
  pullRequest: 946,
  repo: "GetSentry/Junior",
  tag: "V1.2.0",
};

/** The fullest delivery of each webhook, so every optional value is set. */
function fixtureDeliveries(
  scope: FixtureScope,
): Array<{ eventName: string; body: unknown }> {
  const [owner, name] = scope.repo.split("/");
  const repository = { full_name: scope.repo, id: 2001 };
  const pullRequest = {
    draft: false,
    head: { ref: "feat/filters" },
    number: scope.pullRequest,
    user: opener,
  };
  const deployment = {
    created_at: "2026-07-01T12:00:00.000Z",
    environment: scope.environment,
    id: scope.deploymentId,
    sha: scope.deploymentSha,
  };
  const workflow = {
    workflow: { id: 7, path: ".github/workflows/deploy.yml" },
    workflow_run: { id: 9 },
  };
  const comment = {
    body: "Please fix this",
    id: 4001,
    user: { login: "jane" },
  };
  const sender = { id: 77, login: "jane" };
  const checkSuite = (conclusion: string) => ({
    action: "completed",
    check_suite: {
      conclusion,
      head_branch: "feat/filters",
      head_sha: scope.checkSha,
      id: 5001,
      pull_requests: [
        {
          base: { repo: { id: 2001, name, url: "u" } },
          head: { ref: "feat/filters", repo: { id: 2001, name, url: "u" } },
          number: scope.pullRequest,
        },
      ],
    },
    repository: { ...repository, name, owner: { login: owner } },
  });
  return [
    {
      eventName: "deployment",
      body: { action: "created", deployment, repository, ...workflow },
    },
    ...["queued", "pending", "in_progress", "success", "failure", "error"].map(
      (state) => ({
        eventName: "deployment_status",
        body: {
          action: "created",
          deployment,
          deployment_status: { state },
          repository,
          ...workflow,
        },
      }),
    ),
    ...["opened", "closed", "reopened"].map((action) => ({
      eventName: "issues",
      body: { action, issue: { number: scope.issue }, repository },
    })),
    {
      eventName: "issue_comment",
      body: {
        action: "created",
        comment,
        issue: { number: scope.issue },
        repository,
        sender,
      },
    },
    {
      eventName: "issue_comment",
      body: {
        action: "created",
        comment,
        issue: {
          draft: false,
          number: scope.pullRequest,
          pull_request: { url: "u" },
          user: opener,
        },
        repository,
        sender,
      },
    },
    ...[
      { action: "opened" },
      { action: "ready_for_review" },
      { action: "closed", merged: true },
      { action: "closed", merged: false },
    ].map(({ action, merged }) => ({
      eventName: "pull_request",
      body: { action, pull_request: { ...pullRequest, merged }, repository },
    })),
    ...["APPROVED", "CHANGES_REQUESTED", "COMMENTED"].map((state) => ({
      eventName: "pull_request_review",
      body: {
        action: "submitted",
        pull_request: pullRequest,
        repository,
        review: { body: "Looks good", state, user: { login: "jane" } },
        sender,
      },
    })),
    {
      eventName: "pull_request_review_comment",
      body: {
        action: "created",
        comment,
        pull_request: pullRequest,
        repository,
        sender,
      },
    },
    { eventName: "check_suite", body: checkSuite("failure") },
    { eventName: "check_suite", body: checkSuite("success") },
    // A main-branch suite that GitHub links to no pull request.
    {
      eventName: "check_suite",
      body: {
        ...checkSuite("failure"),
        check_suite: {
          ...checkSuite("failure").check_suite,
          head_branch: "main",
          pull_requests: [],
        },
      },
    },
    releaseDelivery(scope.repo, scope.tag),
  ];
}

function releaseDelivery(repo: string, tag: string) {
  return {
    eventName: "release",
    body: {
      action: "published",
      release: { draft: false, id: 6001, tag_name: tag },
      repository: { full_name: repo, id: 2001 },
    },
  };
}

/** Publish deliveries the way the webhook route does, with every lookup. */
async function publish(
  deliveries: Array<{ eventName: string; body: unknown }>,
  deliveryPrefix: string,
): Promise<EventInput[]> {
  const fieldNames = [
    ...new Set(
      (githubPlugin().events?.resourceTypes ?? []).flatMap((resourceType) =>
        Object.keys(resourceType.matchFields ?? {}),
      ),
    ),
  ];
  const botEmail = "264270552+sentry-junior[bot]@users.noreply.github.com";
  const events: EventInput[] = [];
  for (const [index, delivery] of deliveries.entries()) {
    const deliveryId = `${deliveryPrefix}-${index}`;
    const known: Record<string, unknown>[] = [];
    const published = await withGitHubPullRequestMatchData({
      body: delivery.body,
      botEmail,
      db,
      deliveryId,
      events: normalizeGitHubEvents({
        ...delivery,
        botEmail,
        checkSuiteFacts: {
          pullRequestFactsByNumber: {
            [BASE_SCOPE.pullRequest]: {
              isDraft: false,
              openerEmail: opener.email,
              openerUsername: opener.login,
            },
          },
        },
        deliveryId,
      }),
      hasMatch: async () => true,
      loadAuthors: async () => ["dcramer"],
      loadRole: async () => "write",
      neededMatchKeys: async (input) => {
        known.push(input.data ?? {});
        return fieldNames;
      },
    });
    // Core skips broad triggers whose filters fail on the data it gets
    // before the lookups, so every published copy must have that data.
    for (const data of known) {
      for (const event of published) {
        expect(event.data).toMatchObject(data);
      }
    }
    // When every copy is for one pull request, core gets its number, so a
    // trigger for another pull request skips the lookups.
    const numbers = [
      ...new Set(published.map((event) => event.data?.pullRequest)),
    ];
    const onePullRequest = numbers.length === 1 ? numbers[0] : undefined;
    expect(known.map((data) => data.pullRequest)).toEqual(
      known.map(() => onePullRequest),
    );
    events.push(...published);
  }
  return events;
}

describe("GitHub event data", () => {
  it("declares filter events that match the data the webhooks set", async () => {
    const events = await publish(fixtureDeliveries(BASE_SCOPE), "delivery");
    const resourceTypes = githubPlugin().events?.resourceTypes ?? [];

    expect(filterEventMismatches({ resourceTypes, events })).toEqual([]);

    // Events of one kind set the same scope values, so one filter fits them
    // all. Check results on a branch with no pull request have no
    // `pullRequest`; the fixture above proves that the filter allows it.
    const requiredKeys = (eventType: string) =>
      eventType.startsWith("pull_request.checks.")
        ? ["repo", "commitSha"]
        : eventType.startsWith("pull_request.")
          ? ["repo", "pullRequest"]
          : eventType.startsWith("issue.")
            ? ["repo", "issue"]
            : eventType.startsWith("deployment.")
              ? ["repo", "commitSha", "deploymentId", "environment"]
              : ["repo", "tag"];
    const missing = events.flatMap((event) =>
      requiredKeys(event.eventType)
        .filter((key) => event.data?.[key] === undefined)
        .map((key) => `${event.eventType} does not set ${key}`),
    );
    expect(missing).toEqual([]);

    // Scope values are lowercase, the same form as identifiers.
    const scopeValues = (key: string) =>
      new Set(events.flatMap((event) => event.data?.[key] ?? []));
    expect(scopeValues("repo")).toEqual(new Set(["getsentry/junior"]));
    expect(scopeValues("commitSha")).toEqual(
      new Set(["a".repeat(40), "b".repeat(40)]),
    );
    expect(scopeValues("tag")).toEqual(new Set(["v1.2.0"]));
  });

  it("turns each identifier into filters that select only its events", async () => {
    const events = [
      ...(await publish(fixtureDeliveries(BASE_SCOPE), "base")),
      // The same repository and commit, with other numbers, another
      // environment, and a tag with a slash and a non-ASCII letter.
      ...(await publish(
        fixtureDeliveries({
          ...BASE_SCOPE,
          checkSha: "C".repeat(40),
          deploymentId: 3002,
          environment: " Staging EU ",
          issue: 13,
          pullRequest: 947,
          tag: "Release/Ü1",
        }),
        "sibling",
      )),
      // A tag that differs from the one above only in a non-ASCII letter.
      ...(await publish(
        [releaseDelivery(BASE_SCOPE.repo, "Release/ü1")],
        "lowercase-tag",
      )),
      // The same numbers in another repository.
      ...(await publish(
        fixtureDeliveries({ ...BASE_SCOPE, repo: "getsentry/sentry" }),
        "other-repo",
      )),
    ];

    expect(
      identifierMatchMismatches({
        resourceTypes: githubPlugin().events?.resourceTypes ?? [],
        events,
        matches: eventMatches,
        // Saved identifiers went through the plugin's `normalizeIdentifier`.
        toMatch: ({ eventType, identifier }) =>
          githubPlugin().events?.identifierMatch?.({
            eventType,
            identifier: identifier.toLowerCase(),
          }),
      }),
    ).toEqual([]);
    // An identifier that the webhooks never build gets no filters, so a
    // trigger that never ran does not start to run.
    const sha = "a".repeat(40);
    expect(
      [
        ["release-source:getsentry/junior:release/1.0", "release.published"],
        [
          `deployment-source:getsentry/junior:prod/eu:${sha}`,
          "deployment.failed",
        ],
        ["getsentry/junior#007", "pull_request.opened"],
        ["getsentry/junior#007", "issue.opened"],
      ].map(([identifier, eventType]) =>
        githubPlugin().events?.identifierMatch?.({
          identifier: identifier!,
          eventType: eventType!,
        }),
      ),
    ).toEqual([undefined, undefined, undefined, undefined]);
    // Tags keep their text: no URI encoding, and only ASCII letters change.
    expect(new Set(events.flatMap((event) => event.data?.tag ?? []))).toEqual(
      new Set(["v1.2.0", "release/Ü1", "release/ü1"]),
    );
  });
});
