import { strictProviderSchemaProblems } from "@sentry/junior-testing/structured-output";
import { describe, expect, it } from "vitest";
import {
  briefRepositories,
  interpretClassification,
  renderSpaceOutline,
  spaceClassificationSchema,
  type SpaceClassificationOutput,
} from "@/chat/spaces/classify";
import { buildSpaceTree } from "@/chat/spaces/tree";
import type { Space } from "@/chat/spaces/types";

function space(spaceId: string, name: string, parentSpaceId?: string): Space {
  return {
    spaceId,
    name,
    description: `${name} work.`,
    ...(parentSpaceId ? { parentSpaceId } : undefined),
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

const tree = buildSpaceTree(
  [
    space("replay", "Session Replay"),
    space("sdks", "SDKs"),
    space("js", "JavaScript", "sdks"),
    space("python", "Python", "sdks"),
  ],
  new Map([
    ["js", { conversationCount: 3 }],
    ["python", { conversationCount: 1 }],
  ]),
);
const outline = renderSpaceOutline(tree);

function output(
  overrides: Partial<SpaceClassificationOutput>,
): SpaceClassificationOutput {
  return {
    decision: "existing",
    spaceHandle: null,
    parentHandle: null,
    name: null,
    description: null,
    kind: "question",
    confidence: 0.8,
    reason: "Fits.",
    ...overrides,
  };
}

describe("Space classification", () => {
  it("uses a provider-safe output schema", () => {
    expect(strictProviderSchemaProblems(spaceClassificationSchema)).toEqual([]);
  });

  it("renders the tree depth-first with counts and short handles", () => {
    expect(outline.text).toBe(
      [
        "- S1 SDKs (4): SDKs work.",
        "  - S2 JavaScript (3): JavaScript work.",
        "  - S3 Python (1): Python work.",
        "- S4 Session Replay (0): Session Replay work.",
      ].join("\n"),
    );
  });

  it("maps handles to Spaces and enforces tree rules", () => {
    const interpret = (
      overrides: Partial<SpaceClassificationOutput>,
      allowCreate = true,
    ) =>
      interpretClassification({
        output: output(overrides),
        handles: outline.handles,
        tree,
        allowCreate,
      });

    expect(interpret({ spaceHandle: "S2" })).toMatchObject({
      kind: "existing",
      spaceId: "js",
    });
    expect(interpret({ spaceHandle: "S99" })).toBeUndefined();
    expect(
      interpret({
        decision: "create",
        parentHandle: "S2",
        name: " Cloudflare  Workers ",
        description: "Conversations about Cloudflare Workers, edge runtime.",
        confidence: 4,
      }),
    ).toEqual({
      kind: "create",
      parentSpaceId: "js",
      name: "Cloudflare Workers",
      description: "Cloudflare Workers, edge runtime",
      conversationKind: "question",
      confidence: 1,
      reason: "Fits.",
    });
    // A proposed name that already exists joins that Space.
    expect(
      interpret({ decision: "create", parentHandle: "S1", name: "python" }),
    ).toMatchObject({ kind: "existing", spaceId: "python" });
    // Private Conversations and invalid names fall back to the parent.
    expect(
      interpret(
        { decision: "create", parentHandle: "S1", name: "Secret" },
        false,
      ),
    ).toMatchObject({ kind: "existing", spaceId: "sdks" });
    expect(
      interpret({ decision: "create", parentHandle: "S1", name: "" }),
    ).toMatchObject({ kind: "existing", spaceId: "sdks" });
    expect(
      interpret({ decision: "create", parentHandle: null, name: "Top" }, false),
    ).toBeUndefined();
  });

  it("reads repositories from Brief links, most linked first", () => {
    expect(
      briefRepositories([
        { url: "https://github.com/getsentry/sentry/issues/1" },
        { url: "https://github.com/getsentry/junior/pull/1988" },
        { url: "https://github.com/getsentry/junior.git" },
        { url: "https://docs.sentry.io/" },
      ]),
    ).toEqual(["getsentry/junior", "getsentry/sentry"]);
  });
});
