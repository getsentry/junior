import { bindPluginTool } from "@sentry/junior-testing/plugin-tool";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubUpdatePullRequestTool } from "../src/tools/update-pull-request";

const ATTRIBUTED_BODY = `Original body

<!-- junior-request-attribution:start -->
via @lcian.
<!-- junior-request-attribution:end -->`;

function toolContext(
  response?: Response,
  options: {
    actor?: unknown;
    currentBody?: string;
    decider?: unknown;
    /** Overrides the host's work owner. By default the Turn Actor. */
    workOwner?: unknown;
  } = {},
) {
  const fetch = vi.fn(async (input: { operation: string }) => {
    // Updates read the body that is on GitHub before they write.
    if (input.operation === "github.pull.get") {
      return new Response(
        JSON.stringify({ body: options.currentBody ?? null }),
        { status: 200 },
      );
    }
    return (
      response ??
      new Response(
        JSON.stringify({
          base: { ref: "release" },
          body: "Updated body",
          draft: false,
          merged: false,
          html_url: "https://github.com/getsentry/junior/pull/691",
          number: 691,
          state: "open",
          title: "Updated title",
        }),
        { status: 200 },
      )
    );
  });
  const ctxActor = options.actor ?? {
    platform: "slack",
    fullName: "David Cramer",
    userId: "U039RR91S",
    userName: "david",
  };
  const ctx = {
    actor: ctxActor,
    conversationId: "slack:C123:123.456",
    egress: { fetch },
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    events: { canSubscribe: true },
    conversationLink: { url: "https://example.com/session" },
    resolveWorkOwner: async () =>
      "workOwner" in options
        ? options.workOwner
        : { kind: "person", actor: ctxActor },
  };
  return {
    fetch,
    tool: bindPluginTool(
      createGitHubUpdatePullRequestTool(options.decider !== undefined),
      { ...ctx, decider: options.decider } as any,
    ),
  };
}

/** The card facts that an update saves for this GitHub pull request response. */
async function savedFacts(pullRequest: Record<string, unknown>) {
  const { tool } = toolContext(
    new Response(
      JSON.stringify({
        base: { ref: "main" },
        draft: false,
        head: { ref: "feat/events" },
        html_url: "https://github.com/getsentry/junior/pull/691",
        merged: false,
        number: 691,
        state: "open",
        title: "Updated title",
        ...pullRequest,
      }),
      { status: 200 },
    ),
  );
  const result = (await tool.execute?.(
    { repo: "getsentry/junior", pull_request: 691, title: "Updated title" },
    { toolCallId: "update-pr" },
  )) as { objectAnnotations: Array<{ facts: Record<string, unknown> }> };
  return result.objectAnnotations[0]!.facts;
}

async function patchedBody(fetch: ReturnType<typeof toolContext>["fetch"]) {
  const call = fetch.mock.calls.find(
    ([input]) => input.operation === "github.pull.update",
  )?.[0] as { request: Request } | undefined;
  if (!call) throw new Error("No pull request update was sent.");
  return ((await call.request.clone().json()) as { body: string }).body;
}

describe("updatePullRequest", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("updates mutable pull request fields and preserves runtime-owned body metadata", async () => {
    const { fetch, tool } = toolContext(undefined, {
      currentBody: ATTRIBUTED_BODY,
    });

    await expect(
      tool.execute?.(
        {
          repo: "getsentry/junior",
          pull_request: 691,
          title: "Updated title",
          body: "Updated body",
          base: "release",
          state: "open",
        },
        { toolCallId: "update-pr" },
      ),
    ).resolves.toMatchObject({
      base: "release",
      number: 691,
      state: "open",
      objectAnnotations: [{ status: "open", description: "Updated body" }],
      target: "updatePullRequest",
      title: "Updated title",
      subscribable: {
        identifier: "getsentry/junior#691",
      },
      url: "https://github.com/getsentry/junior/pull/691",
    });

    expect(fetch.mock.calls[0]?.[0]).toMatchObject({
      operation: "github.pull.get",
    });
    const call = fetch.mock.calls[1]?.[0];
    expect(call).toMatchObject({
      operation: "github.pull.update",
      provider: "github",
    });
    expect(call?.request.method).toBe("PATCH");
    expect(call?.request.url).toBe(
      "https://api.github.com/repos/getsentry/junior/pulls/691",
    );
    await expect(call?.request.clone().json()).resolves.toMatchObject({
      base: "release",
      state: "open",
      title: "Updated title",
      body: expect.stringContaining("Updated body"),
    });
    const body = (await call?.request.clone().json()) as { body: string };
    // A new requester joins the requesters already on GitHub.
    expect(body.body).toContain("via @lcian, **David Cramer**.");
    expect(body.body).toContain("[View Session](https://example.com/session)");
  });

  // The pull request starts as `via @lcian.`. The model sends a body without
  // the attribution block, because it reads descriptions with the block
  // removed.
  const jan = {
    platform: "slack",
    fullName: "Jan Michael Auer",
    teamId: "T1",
    userId: "U2",
  };
  it.each([
    {
      name: "a review event keeps the requesters",
      actor: { platform: "system", name: "event" },
      expected: "via @lcian.",
    },
    {
      name: "another person with a linked GitHub account is added",
      actor: jan,
      workOwner: {
        kind: "person",
        user: { identities: [{ provider: "github", handle: "jan-auer" }] },
      },
      expected: "via @lcian, @jan-auer.",
    },
    {
      name: "another person without a linked GitHub account is added",
      actor: jan,
      expected: "via @lcian, **Jan Michael Auer**.",
    },
    {
      name: "the same requester is not added twice",
      actor: {
        platform: "slack",
        fullName: "Lorenzo Cian",
        teamId: "T1",
        userId: "U3",
      },
      workOwner: {
        kind: "person",
        user: { identities: [{ provider: "github", handle: "lcian" }] },
      },
      expected: "via @lcian.",
    },
    {
      name: "an automation run is added after the people",
      actor: { platform: "system", name: "automation" },
      workOwner: {
        kind: "system",
        name: "automation",
        id: "evt_1",
        runId: "run_1",
      },
      expected: "via @lcian, automation `evt_1` · Run ID `run_1`.",
    },
    {
      name: "each automation run is kept, like each person",
      actor: { platform: "system", name: "automation" },
      workOwner: {
        kind: "system",
        name: "automation",
        id: "evt_1",
        runId: "run_2",
      },
      currentBody: `Original body

<!-- junior-request-attribution:start -->
via @lcian, automation \`evt_1\` · Run ID \`run_1\`.
<!-- junior-request-attribution:end -->`,
      expected:
        "via @lcian, automation `evt_1` · Run ID `run_1`, automation `evt_1` · Run ID `run_2`.",
    },
  ])("$name", async ({ actor, currentBody, expected, workOwner }) => {
    const { fetch, tool } = toolContext(undefined, {
      actor,
      currentBody: currentBody ?? ATTRIBUTED_BODY,
      ...(workOwner ? { workOwner } : undefined),
    });

    await tool.execute?.(
      { repo: "getsentry/junior", pull_request: 691, body: "Updated body" },
      { toolCallId: "update-pr" },
    );

    const body = await patchedBody(fetch);
    expect(body).toMatch(
      /^Updated body\n\n<!-- junior-request-attribution:start -->/,
    );
    expect(body).toContain(`\n${expected}\n`);
  });

  it("with the description check experiment on, rejects a body that fails a check and does not write it", async () => {
    // The decision model finds a test plan and nothing else.
    const decider = {
      decide: vi.fn(async ({ instructions }: { instructions: string }) => ({
        choice: instructions.includes("test plan") ? "yes" : "no",
      })),
    };
    const { fetch, tool } = toolContext(undefined, { decider });

    await expect(
      tool.execute?.(
        {
          repo: "getsentry/junior",
          pull_request: 691,
          body: "Retry timed-out webhooks.\n\n## Test plan\n- [x] pnpm test",
        },
        { toolCallId: "update-pr" },
      ),
    ).rejects.toMatchObject({
      name: "PluginToolInputError",
      message: expect.stringContaining(
        "- Remove check results, test plans, test coverage notes, and commands.",
      ),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("with the description check experiment on, rejects a blank body without asking the decision model", async () => {
    const decider = { decide: vi.fn() };
    const { fetch, tool } = toolContext(undefined, { decider });

    await expect(
      tool.execute?.(
        { repo: "getsentry/junior", pull_request: 691, body: "  " },
        { toolCallId: "update-pr" },
      ),
    ).rejects.toMatchObject({
      name: "PluginToolInputError",
      message: expect.stringContaining("- Say why the change is needed."),
    });
    expect(decider.decide).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves merged status when updating a merged pull request", async () => {
    const { fetch, tool } = toolContext(
      new Response(
        JSON.stringify({
          base: { ref: "main" },
          body: "Updated body",
          draft: false,
          merged: true,
          mergeable: false,
          html_url: "https://github.com/getsentry/junior/pull/691",
          number: 691,
          state: "closed",
          title: "Updated title",
        }),
        { status: 200 },
      ),
    );

    await expect(
      tool.execute?.(
        { repo: "getsentry/junior", pull_request: 691, title: "Updated title" },
        { toolCallId: "update-merged-pr" },
      ),
    ).resolves.toMatchObject({
      objectAnnotations: [
        {
          // A closed pull request has no merge state to show.
          facts: expect.not.objectContaining({ mergeable: false }),
          key: "getsentry/junior#691",
          status: "merged",
          title: "Updated title",
        },
      ],
    });
    // Without a body, the update does not read or rewrite the description.
    expect(fetch.mock.calls.map(([input]) => input.operation)).toEqual([
      "github.pull.update",
    ]);
  });

  it("saves card facts with the artifact and GitHub attachment images as previews", async () => {
    vi.stubEnv("JUNIOR_BASE_URL", "https://junior.example.com");
    const artifact =
      "https://junior.example.com/public/artifacts/0123456789abcdef.png";
    const after =
      "https://junior.example.com/public/artifacts/fedcba9876543210.png";
    const attachment =
      "https://github.com/user-attachments/assets/0f8c2d6e-5a4b-4c3d-9e8f-7a6b5c4d3e2f";
    const body = [
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
    ].join("\n");

    await expect(
      savedFacts({
        body,
        user: { login: "alex" },
        requested_reviewers: [{ login: "sam" }],
        changed_files: 8,
        additions: 120,
        deletions: 30,
      }),
    ).resolves.toEqual({
      type: "code_change",
      author: "alex",
      reviewers: ["sam"],
      sourceBranch: "feat/events",
      targetBranch: "main",
      changedFiles: 8,
      additions: 120,
      deletions: 30,
      previewImageUrls: [attachment, artifact, after],
    });
    for (const other of [
      "![Private](https://github.com/user-attachments/assets/1)",
      "No image.",
    ]) {
      await expect(savedFacts({ body: other })).resolves.not.toHaveProperty(
        "previewImageUrls",
      );
    }
  });

  it("saves as many preview images as fit in the facts limit", async () => {
    vi.stubEnv("JUNIOR_BASE_URL", "https://junior.example.com");
    const images = Array.from(
      { length: 80 },
      (_, index) =>
        `https://junior.example.com/public/artifacts/${String(index).padStart(16, "0")}.png`,
    );

    const facts = await savedFacts({
      body: images.map((url) => `![Step](${url})`).join("\n"),
      // 180 extra UTF-8 bytes, more than one image entry, so counting
      // characters instead of bytes would save one image too many.
      user: { login: "ü".repeat(60) },
      head: { ref: "ü".repeat(60) },
      base: { ref: "ü".repeat(60) },
    });
    const saved = facts["previewImageUrls"] as string[];

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

  it("marks a draft pull request ready for review through GraphQL", async () => {
    const { fetch, tool } = toolContext();
    const draftPull = {
      base: { ref: "main" },
      body: "Body",
      draft: true,
      merged: false,
      html_url: "https://github.com/getsentry/junior/pull/691",
      node_id: "PR_kwDO691",
      number: 691,
      state: "open",
      title: "Title",
    };
    fetch
      .mockResolvedValueOnce(new Response(JSON.stringify(draftPull)))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              result: { pullRequest: { isDraft: false } },
            },
          }),
        ),
      );

    await expect(
      tool.execute?.(
        { repo: "getsentry/Junior", pull_request: 691, draft: false },
        { toolCallId: "ready-pr" },
      ),
    ).resolves.toMatchObject({
      draft: false,
      objectAnnotations: [{ status: "open" }],
    });

    const [read, mutation] = fetch.mock.calls.map((call) => call[0]);
    expect(read).toMatchObject({ operation: "github.pull.get" });
    expect(read?.request.method).toBe("GET");
    expect(mutation).toMatchObject({
      operation: "github.pull.draft.update:getsentry/junior",
      provider: "github",
    });
    expect(mutation?.request.url).toBe("https://api.github.com/graphql");
    await expect(mutation?.request.clone().json()).resolves.toMatchObject({
      operationName: "MarkPullRequestReadyForReview",
      variables: { id: "PR_kwDO691" },
    });

    // GraphQL reports failures in a 200 response body.
    fetch
      .mockResolvedValueOnce(new Response(JSON.stringify(draftPull)))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            errors: [{ message: "Resource not accessible by integration" }],
          }),
        ),
      );
    await expect(
      tool.execute?.(
        { repo: "getsentry/junior", pull_request: 691, draft: false },
        { toolCallId: "ready-pr-denied" },
      ),
    ).rejects.toThrow(
      "GitHub pull request draft update failed with HTTP 200: Resource not accessible by integration",
    );
  });

  it("asks only the requester to review a draft, once", async () => {
    const actor = { platform: "system", userId: "system" };
    const { fetch, tool } = toolContext(undefined, {
      actor,
      workOwner: {
        kind: "person",
        user: { identities: [{ provider: "github", handle: "BYK" }] },
      },
    });
    const draftPull = {
      base: { ref: "main" },
      body: "Body",
      draft: true,
      merged: false,
      html_url: "https://github.com/getsentry/junior/pull/691",
      number: 691,
      state: "open",
      title: "Title",
    };
    const reviewer = (input: {
      requested: string[];
      reviews: Array<{ state: string }>;
    }) =>
      new Response(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewRequests: {
                  nodes: input.requested.map((login) => ({
                    requestedReviewer: { __typename: "User", login },
                  })),
                },
                reviews: { nodes: input.reviews },
              },
            },
          },
        }),
      );
    const request = { repo: "getsentry/junior", pull_request: 691 } as const;

    // With no review yet, or a dismissed one, GitHub asks them. A comment
    // after a dismissed approval waits for a new ask, so it asks too.
    for (const reviews of [
      [],
      [{ state: "DISMISSED" }],
      [{ state: "DISMISSED" }, { state: "COMMENTED" }],
    ]) {
      fetch
        .mockResolvedValueOnce(new Response(JSON.stringify(draftPull)))
        .mockResolvedValueOnce(reviewer({ requested: [], reviews }))
        .mockResolvedValueOnce(new Response("{}", { status: 201 }));
      await expect(
        tool.execute?.(
          { ...request, request_review: true },
          { toolCallId: "ask-requester" },
        ),
      ).resolves.toMatchObject({ draft: true, review_requested: true });
      const ask = fetch.mock.calls.at(-1)?.[0] as {
        operation: string;
        request: Request;
      };
      expect(ask.operation).toBe("github.pull.request_reviewers");
      expect(ask.request.url).toBe(
        "https://api.github.com/repos/getsentry/junior/pulls/691/requested_reviewers",
      );
      await expect(ask.request.clone().json()).resolves.toEqual({
        reviewers: ["BYK"],
      });
    }

    // GitHub already asks them, or they reviewed it: no new request. The
    // review-again flow owns a change request or a comment-only review. An
    // approval stands when a comment follows it.
    for (const state of [
      { requested: ["byk"], reviews: [] },
      { requested: [], reviews: [{ state: "COMMENTED" }] },
      { requested: [], reviews: [{ state: "APPROVED" }] },
      {
        requested: [],
        reviews: [{ state: "APPROVED" }, { state: "COMMENTED" }],
      },
      { requested: [], reviews: [{ state: "CHANGES_REQUESTED" }] },
    ]) {
      fetch
        .mockResolvedValueOnce(new Response(JSON.stringify(draftPull)))
        .mockResolvedValueOnce(reviewer(state));
      const calls = fetch.mock.calls.length;
      const result = await tool.execute?.(
        { ...request, request_review: true },
        { toolCallId: "ask-requester-again" },
      );
      expect(result).toMatchObject({
        review_requested: state.requested.length > 0,
      });
      expect(fetch.mock.calls.length - calls).toBe(2);
    }
  });

  it("does not ask for a review when the requester has no linked GitHub account", async () => {
    const { fetch, tool } = toolContext();
    await expect(
      tool.execute?.(
        { repo: "getsentry/junior", pull_request: 691, request_review: true },
        { toolCallId: "ask-unlinked" },
      ),
    ).rejects.toThrow("has no linked GitHub account");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("converts to draft through GraphQL and skips no-op draft changes", async () => {
    const { fetch, tool } = toolContext();
    const readyPull = {
      base: { ref: "main" },
      body: "Body",
      draft: false,
      merged: false,
      html_url: "https://github.com/getsentry/junior/pull/691",
      node_id: "PR_kwDO691",
      number: 691,
      state: "open",
      title: "New title",
    };
    fetch
      .mockResolvedValueOnce(new Response(JSON.stringify(readyPull)))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              result: { pullRequest: { isDraft: true } },
            },
          }),
        ),
      );

    await expect(
      tool.execute?.(
        {
          repo: "getsentry/junior",
          pull_request: 691,
          title: "New title",
          draft: true,
        },
        { toolCallId: "draft-pr" },
      ),
    ).resolves.toMatchObject({ draft: true, title: "New title" });
    const [patch, mutation] = fetch.mock.calls.map((call) => call[0]);
    expect(patch).toMatchObject({ operation: "github.pull.update" });
    expect(patch?.request.method).toBe("PATCH");
    await expect(patch?.request.clone().json()).resolves.toEqual({
      title: "New title",
    });
    await expect(mutation?.request.clone().json()).resolves.toMatchObject({
      operationName: "ConvertPullRequestToDraft",
    });

    fetch.mockClear();
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(readyPull)));
    await expect(
      tool.execute?.(
        { repo: "getsentry/junior", pull_request: 691, draft: false },
        { toolCallId: "already-ready" },
      ),
    ).resolves.toMatchObject({ draft: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { repo: "getsentry/junior", pull_request: 691 },
    { repo: "getsentry/junior", pull_request: 691, title: "   " },
    { repo: "getsentry/junior", pull_request: 691, base: "" },
  ])("rejects invalid updates before calling GitHub", async (input) => {
    const { fetch, tool } = toolContext();

    await expect(
      tool.execute?.(input, { toolCallId: "update-pr" }),
    ).rejects.toThrow("Invalid GitHub updatePullRequest input.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns a rejected update to the model with GitHub's error message", async () => {
    const { tool } = toolContext(
      new Response(JSON.stringify({ message: "Validation Failed" }), {
        status: 422,
      }),
    );

    await expect(
      tool.execute?.(
        { repo: "getsentry/junior", pull_request: 691, base: "missing" },
        { toolCallId: "update-pr" },
      ),
    ).rejects.toMatchObject({
      name: "PluginToolInputError",
      message:
        "GitHub pull request update failed with HTTP 422: Validation Failed. Check repo and pull_request, and fix any field that GitHub names.",
    });
  });

  it("keeps GitHub server failures as system errors", async () => {
    const { tool } = toolContext(
      new Response(JSON.stringify({ message: "Server Error" }), {
        status: 500,
      }),
    );

    await expect(
      tool.execute?.(
        { repo: "getsentry/junior", pull_request: 691, base: "main" },
        { toolCallId: "update-pr" },
      ),
    ).rejects.toMatchObject({
      name: "Error",
      message: "GitHub pull request update failed with HTTP 500: Server Error",
    });
  });
});

describe("updatePullRequest call facts", () => {
  const tool = createGitHubUpdatePullRequestTool();

  async function describeUpdate(input: Record<string, unknown>) {
    return await tool.guardian?.describe?.({
      repo: "getsentry/junior",
      pull_request: 691,
      ...input,
    } as never);
  }

  it("calls a title or body update an edit of the pull request", async () => {
    await expect(
      describeUpdate({ title: "New title", body: "New body" }),
    ).resolves.toEqual({
      effect: "edit",
      summary: "Update pull request getsentry/junior#691.",
      target: {
        ref: "getsentry/junior#691",
        audience: "world",
        codeChange: { repository: "getsentry/junior", number: 691 },
      },
    });
  });

  it.each([
    { state: "closed" },
    { draft: false },
    { base: "release" },
    { request_review: true },
  ])("calls an update that also sets %o a write", async (change) => {
    await expect(
      describeUpdate({ body: "New body", ...change }),
    ).resolves.toMatchObject({ effect: "write" });
  });
});
