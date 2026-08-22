import type { ToolRegistrationHookContext } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubGetReleaseTool } from "../src/tools/get-release";
import { createGitHubApiTestAdapter } from "./github-api-adapter";
import { castThroughUnknown } from "@sentry/junior-plugin-api";

const RELEASE = {
  created_at: "2026-08-04T05:15:00Z",
  draft: false,
  html_url: "https://github.com/getsentry/junior/releases/tag/0.129.0",
  id: 2_481_992_013,
  name: "0.129.0",
  prerelease: false,
  published_at: "2026-08-04T05:15:00Z",
  tag_name: "0.129.0",
  target_commitish: "main",
};

function toolContext(responses: Array<{ body?: unknown; status?: number }>) {
  const adapter = createGitHubApiTestAdapter(responses);
  const ctx = castThroughUnknown<ToolRegistrationHookContext>({
    egress: adapter.egress,
    resourceEvents: { canSubscribe: true },
  });
  return { adapter, tool: createGitHubGetReleaseTool(ctx) };
}

describe("getRelease", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns release metadata and a tag subscription hint", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "test-secret");
    const { adapter, tool } = toolContext([{ body: RELEASE }]);

    await expect(
      tool.execute?.(
        {
          repo: "GetSentry/Junior",
          tag: "0.129.0",
        },
        { toolCallId: "get-release" },
      ),
    ).resolves.toMatchObject({
      release: {
        htmlUrl: RELEASE.html_url,
        id: RELEASE.id,
        tagName: "0.129.0",
      },
      repo: "GetSentry/Junior",
      tag: "0.129.0",
      subscribable: {
        identifier: "release-source:getsentry/junior:0.129.0",
        suggestedEvents: ["release.published"],
        supportedEvents: ["release.published"],
        type: "release_source",
      },
    });
    expect(adapter.requests()).toEqual([
      expect.objectContaining({
        operation: "github.release.get",
        provider: "github",
      }),
    ]);
    expect(adapter.requests()[0]?.request.url).toContain(
      "/releases/tags/0.129.0",
    );
  });

  it("returns a repository-wide subscription when the tag is omitted", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "test-secret");
    const { adapter, tool } = toolContext([{ body: RELEASE }]);

    await expect(
      tool.execute?.(
        { repo: "GetSentry/Junior" },
        { toolCallId: "watch-releases" },
      ),
    ).resolves.toMatchObject({
      release: {
        id: RELEASE.id,
        tagName: "0.129.0",
      },
      tag: null,
      subscribable: {
        identifier: "release-source:getsentry/junior",
        type: "release_source",
      },
    });
    expect(adapter.requests()).toEqual([
      expect.objectContaining({
        operation: "github.release.latest",
        provider: "github",
      }),
    ]);
    expect(adapter.requests()[0]?.request.url).toContain("/releases/latest");
  });

  it("skips drafts by using GitHub's latest non-draft release endpoint", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "test-secret");
    const { tool } = toolContext([{ body: RELEASE }]);

    await expect(
      tool.execute?.(
        { repo: "getsentry/junior" },
        { toolCallId: "latest-non-draft" },
      ),
    ).resolves.toMatchObject({
      release: {
        draft: false,
        id: RELEASE.id,
        tagName: "0.129.0",
      },
      tag: null,
    });
  });

  it("returns a null release when GitHub has no published non-draft release yet", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "test-secret");
    const { tool } = toolContext([
      { body: { message: "Not Found" }, status: 404 },
    ]);

    await expect(
      tool.execute?.(
        { repo: "getsentry/junior" },
        { toolCallId: "no-published-release" },
      ),
    ).resolves.toMatchObject({
      release: null,
      tag: null,
      subscribable: {
        identifier: "release-source:getsentry/junior",
      },
    });
  });

  it("returns a subscribable source before GitHub publishes the tag", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "test-secret");
    const { tool } = toolContext([
      { body: { message: "Not Found" }, status: 404 },
    ]);

    await expect(
      tool.execute?.(
        {
          repo: "getsentry/junior",
          tag: "0.129.0",
        },
        { toolCallId: "missing-tag" },
      ),
    ).resolves.toMatchObject({
      release: null,
      tag: "0.129.0",
      subscribable: {
        identifier: "release-source:getsentry/junior:0.129.0",
      },
    });
  });

  it("omits the hint when GitHub webhooks are not configured", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "");
    const { tool } = toolContext([{ body: RELEASE }]);

    const result = await tool.execute?.(
      {
        repo: "getsentry/junior",
        tag: "0.129.0",
      },
      { toolCallId: "no-webhook" },
    );

    expect(result).not.toHaveProperty("subscribable");
    expect(result).not.toHaveProperty("data.subscribable");
  });

  it("reports non-404 latest lookup failures as runtime errors", async () => {
    const { tool } = toolContext([
      { body: { message: "Server Error" }, status: 500 },
    ]);

    await expect(
      tool.execute?.(
        { repo: "getsentry/junior" },
        { toolCallId: "latest-failed" },
      ),
    ).rejects.toMatchObject({
      message: "GitHub release lookup failed with HTTP 500",
      name: "Error",
    });
  });
});
