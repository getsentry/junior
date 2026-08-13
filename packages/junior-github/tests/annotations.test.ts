import {
  conversationSidebarAnnotationSchema,
  type ConversationAnnotation,
} from "@sentry/junior-plugin-api";
import { describe, expect, it } from "vitest";
import { githubSidebarAnnotation } from "../src/annotations";

function annotation(
  repo: string,
  number: number,
  status: NonNullable<ConversationAnnotation["status"]>,
  owner = "getsentry",
): ConversationAnnotation {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    key: `${owner}/${repo}#${number}`,
    kind: "resource_link",
    label: `${owner}/${repo}#${number}`,
    plugin: "github",
    status,
    updatedAt: "2026-01-01T00:00:01.000Z",
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
  };
}

describe("GitHub conversation sidebar", () => {
  it("selects repository scope and final status", () => {
    expect(
      githubSidebarAnnotation([
        annotation("junior", 1, "merged"),
        annotation("junior", 2, "closed"),
      ]),
    ).toEqual({ icon: "git-merge", key: "github", label: "junior" });
    expect(
      githubSidebarAnnotation([
        annotation("junior", 1, "merged"),
        annotation("payments", 2, "open"),
      ]),
    ).toEqual({ icon: "circle-dot", key: "github", label: "2 repos" });
    expect(
      githubSidebarAnnotation([
        annotation("junior", 1, "closed"),
        annotation("junior", 2, "closed"),
      ]),
    ).toEqual({ icon: "circle-x", key: "github", label: "junior" });
  });

  it("counts repositories with the same name under different owners", () => {
    expect(
      githubSidebarAnnotation([
        annotation("shared", 1, "merged", "getsentry"),
        annotation("shared", 2, "open", "example"),
      ]),
    ).toEqual({ icon: "circle-dot", key: "github", label: "2 repos" });
  });

  it("keeps valid 100-character GitHub repository names", () => {
    const repo = "r".repeat(100);
    const sidebar = githubSidebarAnnotation([annotation(repo, 1, "open")]);
    expect(sidebar).toEqual({ icon: "circle-dot", key: "github", label: repo });
    expect(() => conversationSidebarAnnotationSchema.parse(sidebar)).not.toThrow();
  });
});
