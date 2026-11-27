import type { PluginEgress } from "@sentry/junior-plugin-api";
import { describe, expect, it } from "vitest";
import { describeGitHubUrl } from "../src/describe-url";
import { memoryCache } from "./plugin-harness";

/** GitHub egress that answers each repository read with `body`, or fails. */
function repositoryEgress(body: unknown, status = 200): PluginEgress {
  return {
    async fetch() {
      return Response.json(body, { status });
    },
  };
}

describe("describeGitHubUrl", () => {
  it.each([
    "https://github.com/getsentry/junior",
    "https://github.com/getsentry/junior.git",
    "ssh://git@github.com/getsentry/junior.git",
  ])("reads the repository of %s", async (url) => {
    const ctx = {
      cache: memoryCache(),
      egress: repositoryEgress({ private: false }),
    };
    await expect(describeGitHubUrl(new URL(url), ctx)).resolves.toEqual({
      ref: "getsentry/junior",
      audience: "world",
    });
  });

  it("gives a private repository the internal audience", async () => {
    const ctx = {
      cache: memoryCache(),
      egress: repositoryEgress({ private: true }),
    };
    await expect(
      describeGitHubUrl(new URL("https://github.com/acme/atlas"), ctx),
    ).resolves.toEqual({ ref: "acme/atlas", audience: "internal" });
  });

  it("counts a repository that GitHub does not answer for as world", async () => {
    const ctx = {
      cache: memoryCache(),
      egress: repositoryEgress({ message: "Not Found" }, 404),
    };
    await expect(
      describeGitHubUrl(new URL("https://github.com/acme/atlas"), ctx),
    ).resolves.toEqual({ ref: "acme/atlas", audience: "world" });
  });

  it.each([
    "https://gitlab.com/getsentry/junior",
    "https://github.com/getsentry",
  ])("knows no target for %s", async (url) => {
    const ctx = { cache: memoryCache(), egress: repositoryEgress({}) };
    await expect(describeGitHubUrl(new URL(url), ctx)).resolves.toBeUndefined();
  });
});
