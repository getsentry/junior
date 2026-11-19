import {
  conversationAnnotationInputSchema,
  conversationSidebarAnnotationSchema,
  type ConversationAnnotation,
  type ConversationAnnotationInput,
  type PluginAnnotations,
} from "@sentry/junior-plugin-api";
import { describe, expect, it } from "vitest";
import {
  githubObjectAnnotation,
  githubSidebarAnnotations,
  updateGitHubAnnotation,
} from "../src/annotations";

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
        objectType: "code_change",
        status: "closed",
        key: "getsentry/junior#3",
        label: "junior",
        url: "https://github.com/getsentry/junior/pull/3",
      },
      {
        objectType: "code_change",
        status: "open",
        key: "getsentry/payments#2",
        label: "payments",
        url: "https://github.com/getsentry/payments/pull/2",
      },
      {
        objectType: "code_change",
        status: "merged",
        key: "getsentry/junior#1",
        label: "junior",
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
        url: "https://github.com/getsentry/junior/issues/1",
      },
    ]);
  });

  it("carries a saved object's title, URL, first image and size for row cards", () => {
    expect(
      githubSidebarAnnotations([
        {
          createdAt: "2026-01-01T00:00:00.000Z",
          facts: {
            type: "code_change",
            additions: 1204,
            changedFiles: 12,
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
        // An unknown part stays unset, so no card shows it as 0.
        size: { additions: 1204, changedFiles: 12 },
      },
    ]);
  });
});

function annotationStore(initial: ConversationAnnotation[]): {
  store: PluginAnnotations;
  saved: ConversationAnnotationInput[];
} {
  const saved: ConversationAnnotationInput[] = [];
  return {
    saved,
    store: {
      async list() {
        return initial;
      },
      async remove() {},
      async upsert(input) {
        // Match the core store, which validates every upsert.
        saved.push(conversationAnnotationInputSchema.parse(input));
      },
    },
  };
}

function storedObject(
  objectType: "task" | "code_change",
): ConversationAnnotation {
  return {
    ...githubObjectAnnotation({
      repo: "getsentry/junior",
      number: 42,
      title: "Fix annotations",
      url: `https://github.com/getsentry/junior/${objectType === "code_change" ? "pull" : "issues"}/42`,
      objectType,
      status: "open",
      facts:
        objectType === "code_change"
          ? { type: "code_change", author: "octocat" }
          : { type: "task", labels: ["bug"] },
    }),
    plugin: "github",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
  };
}

describe("updateGitHubAnnotation", () => {
  it("drops task facts when a pull request saved as a task merges", async () => {
    const { store, saved } = annotationStore([storedObject("task")]);

    await updateGitHubAnnotation(store, {
      repo: "getsentry/junior",
      number: 42,
      objectType: "code_change",
      status: "merged",
    });

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      kind: "object",
      key: "getsentry/junior#42",
      objectType: "code_change",
      status: "merged",
      displayType: "Pull request",
    });
    expect(saved[0]).not.toHaveProperty("facts.type");
  });

  it("drops code change facts when the object closes as a task", async () => {
    const { store, saved } = annotationStore([storedObject("code_change")]);

    await updateGitHubAnnotation(store, {
      repo: "getsentry/junior",
      number: 42,
      objectType: "task",
      status: "closed",
    });

    expect(saved[0]).toMatchObject({
      objectType: "task",
      status: "closed",
      displayType: "Issue",
    });
    expect(saved[0]).not.toHaveProperty("facts.type");
  });

  it("keeps facts when the object type is unchanged", async () => {
    const { store, saved } = annotationStore([storedObject("code_change")]);

    await updateGitHubAnnotation(store, {
      repo: "getsentry/junior",
      number: 42,
      objectType: "code_change",
      status: "merged",
    });

    expect(saved[0]).toMatchObject({
      objectType: "code_change",
      status: "merged",
      displayType: "Pull request",
      facts: { type: "code_change", author: "octocat" },
    });
  });
});
