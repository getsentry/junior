import {
  conversationSidebarAnnotationSchema,
  type ConversationAnnotation,
} from "@sentry/junior-plugin-api";
import { describe, expect, it } from "vitest";
import { githubSidebarAnnotations } from "../src/annotations";

function annotation(
  repo: string,
  number: number,
  status: NonNullable<ConversationAnnotation["status"]>,
  owner = "getsentry",
  updatedAt = "2026-01-01T00:00:01.000Z",
  kind: "pull" | "issues" = "pull",
): ConversationAnnotation {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    key: `${owner}/${repo}#${number}`,
    kind: "resource_link",
    label: `${owner}/${repo}#${number}`,
    plugin: "github",
    status,
    updatedAt,
    url: `https://github.com/${owner}/${repo}/${kind}/${number}`,
  };
}

describe("GitHub conversation sidebar", () => {
  it("returns every annotation newest first", () => {
    const sidebar = githubSidebarAnnotations([
      annotation(
        "junior",
        1,
        "merged",
        "getsentry",
        "2026-01-01T00:00:01.000Z",
      ),
      annotation(
        "payments",
        2,
        "open",
        "getsentry",
        "2026-01-01T00:00:02.000Z",
      ),
      annotation(
        "junior",
        3,
        "closed",
        "getsentry",
        "2026-01-01T00:00:03.000Z",
      ),
    ]);

    expect(sidebar).toEqual([
      {
        icon: "circle-x",
        key: "getsentry/junior#3",
        label: "getsentry/junior#3",
      },
      {
        icon: "git-pull-request",
        key: "getsentry/payments#2",
        label: "getsentry/payments#2",
      },
      {
        icon: "git-merge",
        key: "getsentry/junior#1",
        label: "getsentry/junior#1",
      },
    ]);
    expect(() =>
      conversationSidebarAnnotationSchema.array().parse(sidebar),
    ).not.toThrow();
  });

  it("uses the pull request icon for open pull requests", () => {
    expect(githubSidebarAnnotations([annotation("junior", 1, "open")])).toEqual(
      [
        {
          icon: "git-pull-request",
          key: "getsentry/junior#1",
          label: "getsentry/junior#1",
        },
      ],
    );
  });

  it("keeps the issue icon for open issues", () => {
    expect(
      githubSidebarAnnotations([
        annotation("junior", 1, "open", "getsentry", undefined, "issues"),
      ]),
    ).toEqual([
      {
        icon: "circle-dot",
        key: "getsentry/junior#1",
        label: "getsentry/junior#1",
      },
    ]);
  });
});
