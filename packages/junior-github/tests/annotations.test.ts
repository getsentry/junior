import {
  conversationSidebarAnnotationSchema,
  type LiveAnnotation,
} from "@sentry/junior-plugin-api";
import { describe, expect, it } from "vitest";
import { githubSidebarAnnotations } from "../src/annotations";

// The live card of a GitHub object, as core reads it for the sidebar.
function annotation(
  repo: string,
  number: number,
  status: string,
  owner = "getsentry",
  updatedAt = "2026-01-01T00:00:01.000Z",
  kind: "pull" | "issues" = "pull",
): LiveAnnotation {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    key: `${owner}/${repo}#${number}`,
    kind: "object",
    label: `${owner}/${repo}#${number}`,
    objectType: kind === "pull" ? "code_change" : "task",
    plugin: "github",
    status,
    title: `Change ${number}`,
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
        objectType: "code_change",
        status: "closed",
        key: "getsentry/junior#3",
        label: "junior",
        title: "Change 3",
        url: "https://github.com/getsentry/junior/pull/3",
      },
      {
        objectType: "code_change",
        status: "open",
        key: "getsentry/payments#2",
        label: "payments",
        title: "Change 2",
        url: "https://github.com/getsentry/payments/pull/2",
      },
      {
        objectType: "code_change",
        status: "merged",
        key: "getsentry/junior#1",
        label: "junior",
        title: "Change 1",
        url: "https://github.com/getsentry/junior/pull/1",
      },
    ]);
    expect(() =>
      conversationSidebarAnnotationSchema.array().parse(sidebar),
    ).not.toThrow();
  });

  it("preserves code change identity for open pull requests", () => {
    expect(githubSidebarAnnotations([annotation("junior", 1, "open")])).toEqual(
      [
        {
          objectType: "code_change",
          status: "open",
          key: "getsentry/junior#1",
          label: "junior",
          title: "Change 1",
          url: "https://github.com/getsentry/junior/pull/1",
        },
      ],
    );
  });

  it("preserves ticket identity for open issues", () => {
    expect(
      githubSidebarAnnotations([
        annotation(
          "junior",
          1,
          "open",
          "getsentry",
          "2026-01-01T00:00:01.000Z",
          "issues",
        ),
      ]),
    ).toEqual([
      {
        objectType: "task",
        status: "open",
        key: "getsentry/junior#1",
        label: "junior",
        title: "Change 1",
        url: "https://github.com/getsentry/junior/issues/1",
      },
    ]);
  });

  it("carries a live object's title, URL and first image for row cards", () => {
    expect(
      githubSidebarAnnotations([
        {
          createdAt: "2026-01-01T00:00:00.000Z",
          facts: {
            type: "code_change",
            previewImageUrls: [
              "https://junior.example/public/artifacts/before.png",
              "https://junior.example/public/artifacts/after.png",
            ],
          },
          key: "getsentry/junior#7",
          kind: "object",
          label: "getsentry/junior#7",
          objectType: "code_change",
          plugin: "github",
          status: "open",
          title: "Show your week under the home composer",
          updatedAt: "2026-01-01T00:00:01.000Z",
          url: "https://github.com/getsentry/junior/pull/7",
        },
      ]),
    ).toEqual([
      {
        objectType: "code_change",
        status: "open",
        key: "getsentry/junior#7",
        label: "junior",
        title: "Show your week under the home composer",
        url: "https://github.com/getsentry/junior/pull/7",
        imageUrl: "https://junior.example/public/artifacts/before.png",
      },
    ]);
  });
});
