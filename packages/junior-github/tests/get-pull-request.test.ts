import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubGetPullRequestTool } from "../src/tools/get-pull-request";
import { createGitHubApiTestAdapter } from "./github-api-adapter";
const HEAD_SHA = "c610b5d6a88c9da5d65627a1cdb3829b05c14f75";

/** A GraphQL checks response for the head commit. */
function checksResponse(
  rollup: { contexts: unknown[]; hasNextPage?: boolean } | null,
  pullRequest: Record<string, unknown> = {},
) {
  return {
    body: {
      data: {
        repository: {
          pullRequest: {
            autoMergeRequest: null,
            commits: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup: rollup && {
                      contexts: {
                        nodes: rollup.contexts,
                        pageInfo: { hasNextPage: rollup.hasNextPage ?? false },
                      },
                    },
                  },
                },
              ],
            },
            mergeStateStatus: "CLEAN",
            reviewDecision: null,
            ...pullRequest,
          },
        },
      },
    },
  };
}

function checkRun(
  name: string,
  status: string,
  conclusion: string | null,
  isRequired = true,
) {
  return { __typename: "CheckRun", conclusion, isRequired, name, status };
}

/** The REST response for pull request #691. */
function pullRequestResponse() {
  return {
    body: {
      base: { ref: "main" },
      draft: false,
      head: { ref: "feat/events", sha: HEAD_SHA },
      html_url: "https://github.com/getsentry/junior/pull/691",
      merged: false,
      number: 691,
      state: "open",
      title: "Add events",
      body: `Add **events**.<!-- Internal template note --><<!-- nested -->!-- hidden -->

<!-- junior-request-attribution:start -->
via **Alex**.
<!-- junior-request-attribution:end -->

<!-- junior-session-footer:start -->
[View Session](https://example.com/session)
<!-- junior-session-footer:end -->
<!-- unfinished comment`,
      user: { login: "alex" },
      requested_reviewers: [{ login: "sam" }],
      mergeable: null,
      changed_files: 8,
      additions: 120,
      deletions: 30,
      updated_at: "2026-09-25T13:00:00Z",
    },
  };
}

function toolContext(
  canSubscribe = true,
  responses: Array<{ body?: unknown; status?: number }> = [
    pullRequestResponse(),
    checksResponse({ contexts: [checkRun("test", "COMPLETED", "SUCCESS")] }),
  ],
) {
  const adapter = createGitHubApiTestAdapter(responses);
  const ctx = {
    egress: adapter.egress,
    events: { canSubscribe },
  };
  return { adapter, tool: createGitHubGetPullRequestTool(ctx) };
}

describe("getPullRequest", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a subscribable hint for an existing pull request", async () => {
    const { adapter, tool } = toolContext();

    await expect(
      tool.execute?.(
        { repo: "getsentry/junior", number: 691 },
        { toolCallId: "get-pr" },
      ),
    ).resolves.toMatchObject({
      objectAnnotations: [
        {
          displayType: "Pull request",
          description: "Add **events**.",
          sourceUpdatedAt: "2026-09-25T13:00:00Z",
          facts: {
            type: "code_change",
            author: "alex",
            reviewers: ["sam"],
            sourceBranch: "feat/events",
            targetBranch: "main",
            changedFiles: 8,
            additions: 120,
            deletions: 30,
          },
        },
      ],
      head_sha: HEAD_SHA,
      number: 691,
      subscribable: {
        label: "GitHub PR getsentry/junior#691",
        identifier: "getsentry/junior#691",
        match: { repo: "getsentry/junior", pull_request: 691 },
        type: "pull_request",
      },
    });
    expect(adapter.requests()).toEqual([
      expect.objectContaining({
        operation: "github.pull.get",
        provider: "github",
      }),
      expect.objectContaining({
        operation: "github.pull.checks.get",
        provider: "github",
      }),
    ]);
  });

  it("saves the artifact and GitHub attachment images as previews", async () => {
    vi.stubEnv("JUNIOR_BASE_URL", "https://junior.example.com");
    const artifact =
      "https://junior.example.com/public/artifacts/0123456789abcdef.png";
    const after =
      "https://junior.example.com/public/artifacts/fedcba9876543210.png";
    const attachment =
      "https://github.com/user-attachments/assets/0f8c2d6e-5a4b-4c3d-9e8f-7a6b5c4d3e2f";
    const withBody = (body: string) => {
      const response = pullRequestResponse();
      return { body: { ...response.body, body } };
    };
    const checks = checksResponse({ contexts: [] });
    const { tool } = toolContext(true, [
      withBody(
        [
          "![Unknown](https://github.com/user-attachments/assets/1)",
          // A signed attachment URL expires in minutes.
          "![Signed](https://private-user-images.githubusercontent.com/1/2.png?jwt=signed)",
          `![Attachment](${attachment})`,
          "![Other](https://example.com/public/artifacts/0123456789abcdef.png)",
          "```md",
          "![Example](https://junior.example.com/public/artifacts/code.png)",
          "```",
          // A `src=` inside another attribute value is not the image.
          `| Before | After |\n| --- | --- |\n| ![Before][before] | <img alt=" src=https://junior.example.com/public/artifacts/alt.png" src="${after}"> |`,
          `![Again](${artifact})`,
          "",
          `[before]: ${artifact}`,
        ].join("\n"),
      ),
      checks,
      withBody("![Private](https://github.com/user-attachments/assets/1)"),
      checks,
      withBody("No image."),
      checks,
    ]);
    const preview = async () => {
      const result = (await tool.execute?.(
        { repo: "getsentry/junior", number: 691 },
        { toolCallId: "get-pr" },
      )) as { objectAnnotations: Array<{ facts: Record<string, unknown> }> };
      return result.objectAnnotations[0]?.facts.previewImageUrls;
    };

    expect(await preview()).toEqual([attachment, artifact, after]);
    expect(await preview()).toBeUndefined();
    expect(await preview()).toBeUndefined();
  });

  it("saves as many preview images as fit in the facts limit", async () => {
    vi.stubEnv("JUNIOR_BASE_URL", "https://junior.example.com");
    const images = Array.from(
      { length: 80 },
      (_, index) =>
        `https://junior.example.com/public/artifacts/${String(index).padStart(16, "0")}.png`,
    );
    const response = pullRequestResponse();
    const { tool } = toolContext(true, [
      {
        body: {
          ...response.body,
          body: images.map((url) => `![Step](${url})`).join("\n"),
          // 180 extra UTF-8 bytes, more than one image entry, so counting
          // characters instead of bytes would save one image too many.
          user: { login: "ü".repeat(60) },
          head: { ...response.body.head, ref: "ü".repeat(60) },
          base: { ...response.body.base, ref: "ü".repeat(60) },
        },
      },
      checksResponse({ contexts: [] }),
    ]);

    const result = (await tool.execute?.(
      { repo: "getsentry/junior", number: 691 },
      { toolCallId: "get-pr" },
    )) as { objectAnnotations: Array<{ facts: Record<string, unknown> }> };
    const facts = result.objectAnnotations[0]!.facts;
    const saved = facts.previewImageUrls as string[];

    const bytes = (value: unknown) =>
      new TextEncoder().encode(JSON.stringify(value)).length;

    // More than the old fixed 4, in body order, and the next one would not fit.
    expect(saved.length).toBeGreaterThan(4);
    expect(saved).toEqual(images.slice(0, saved.length));
    expect(bytes(facts)).toBeLessThanOrEqual(4096);
    expect(
      bytes({ ...facts, previewImageUrls: images.slice(0, saved.length + 1) }),
    ).toBeGreaterThan(4096);
  });

  it("returns the required checks and the merge state", async () => {
    const { adapter, tool } = toolContext(true, [
      pullRequestResponse(),
      checksResponse(
        {
          contexts: [
            checkRun("test", "COMPLETED", "SUCCESS"),
            checkRun("lint", "IN_PROGRESS", null),
            checkRun("coverage", "COMPLETED", "FAILURE", false),
            {
              __typename: "StatusContext",
              context: "deploy/preview",
              isRequired: true,
              state: "FAILURE",
            },
          ],
          hasNextPage: true,
        },
        {
          autoMergeRequest: { enabledAt: "2026-09-25T13:00:00Z" },
          mergeStateStatus: "BLOCKED",
          reviewDecision: "APPROVED",
        },
      ),
    ]);

    const result = await tool.execute?.(
      { repo: "getsentry/junior", number: 691 },
      { toolCallId: "get-pr-checks" },
    );

    expect(result).toMatchObject({
      checks: {
        auto_merge: true,
        failing: ["deploy/preview"],
        incomplete: true,
        merge_state: "BLOCKED",
        passing: ["test"],
        pending: ["lint"],
        required: "failing",
        review_decision: "APPROVED",
      },
    });
    expect(await adapter.requests()[1]!.request.clone().json()).toMatchObject({
      operationName: "PullRequestChecks",
      variables: { name: "junior", number: 691, owner: "getsentry" },
    });
  });

  it.each([
    { name: "no checks", rollup: null },
    {
      name: "only checks that are not required",
      rollup: {
        contexts: [checkRun("coverage", "COMPLETED", "SUCCESS", false)],
      },
    },
  ])(
    "reports that no required check reported when the head has $name",
    async ({ rollup }) => {
      const { tool } = toolContext(true, [
        pullRequestResponse(),
        checksResponse(rollup, { mergeStateStatus: "BLOCKED" }),
      ]);

      const result = await tool.execute?.(
        { repo: "getsentry/junior", number: 691 },
        { toolCallId: "get-pr-no-required-checks" },
      );

      expect(result).toMatchObject({
        checks: {
          auto_merge: false,
          failing: [],
          merge_state: "BLOCKED",
          passing: [],
          pending: [],
          required: "not_reported",
        },
      });
      expect(result).not.toHaveProperty("checks.incomplete");
    },
  );

  it("omits the hint when the host cannot create subscriptions", async () => {
    const { tool } = toolContext(false);

    const result = await tool.execute?.(
      { repo: "getsentry/junior", number: 691 },
      { toolCallId: "get-pr-without-subscriptions" },
    );

    expect(result).not.toHaveProperty("subscribable");
    expect(result).not.toHaveProperty("data.subscribable");
  });

  it("reports a missing pull request as a repairable tool error", async () => {
    const { tool } = toolContext(true, [
      { body: { message: "Not Found" }, status: 404 },
    ]);

    await expect(
      tool.execute?.(
        { repo: "getsentry/junior", number: 999999 },
        { toolCallId: "missing-pr" },
      ),
    ).rejects.toMatchObject({
      message: "GitHub pull request lookup failed with HTTP 404",
      name: "PluginToolInputError",
    });
  });

  it("reports non-404 pull request lookup failures as runtime errors", async () => {
    const { tool } = toolContext(true, [
      { body: { message: "Internal Server Error" }, status: 500 },
    ]);

    await expect(
      tool.execute?.(
        { repo: "getsentry/junior", number: 691 },
        { toolCallId: "pr-lookup-500" },
      ),
    ).rejects.toMatchObject({
      message: "GitHub pull request lookup failed with HTTP 500",
      name: "Error",
    });
  });
});
