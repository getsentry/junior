import type { ConversationAnnotation } from "@sentry/junior-plugin-api";
import { describe, expect, it } from "vitest";
import { githubSidebarAnnotation } from "../src/annotations";

function annotation(
  repo: string,
  number: number,
  status: NonNullable<ConversationAnnotation["status"]>,
): ConversationAnnotation {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    key: `getsentry/${repo}#${number}`,
    kind: "resource_link",
    label: `getsentry/${repo}#${number}`,
    plugin: "github",
    status,
    updatedAt: "2026-01-01T00:00:01.000Z",
    url: `https://github.com/getsentry/${repo}/pull/${number}`,
  };
}

describe("GitHub conversation sidebar", () => {
  it("selects repository scope and final status", () => {
    expect(
      githubSidebarAnnotation([
        annotation("junior", 1, "merged"),
        annotation("junior", 2, "closed"),
      ]),
    ).toEqual({ key: "github", label: "junior", status: "merged" });
    expect(
      githubSidebarAnnotation([
        annotation("junior", 1, "merged"),
        annotation("payments", 2, "open"),
      ]),
    ).toEqual({ key: "github", label: "2 repos", status: "open" });
    expect(
      githubSidebarAnnotation([
        annotation("junior", 1, "closed"),
        annotation("junior", 2, "closed"),
      ]),
    ).toEqual({ key: "github", label: "junior", status: "closed" });
  });
});
