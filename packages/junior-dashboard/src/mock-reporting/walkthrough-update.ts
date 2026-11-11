import type {
  WalkthroughAnswerResponse,
  WalkthroughDocument,
  WalkthroughExcerpt,
  WalkthroughVersionResponse,
} from "@sentry/junior/api/schema";

/** Fixed ids of the update lineage: a first version and its update. */
export const MOCK_UPDATE_IDS = {
  base: "6b0e8f1e-0000-4000-8000-000000000003",
  update: "6b0e8f1e-0000-4000-8000-000000000004",
} as const;

// Head commits after the stack was rebased and slice 5 joined it.
const HEADS: Record<number, string> = {
  3088: "74f90c7c042c97fb41703ba7a3c413f02ca06cbb",
  3090: "2411d2d82fecf434b272e26db14f3eb821320ab9",
  3124: "c39ee1ee5e7fec11cf8f3c2ca0d0f60d998cd5f3",
  3133: "db07f9780fa3085928b9b62e2edccc6566e2baa5",
  3147: "4333b31996f019711f786b3a7c0084196c84f883",
};

function excerpt(args: {
  pr: number;
  path: string;
  start: number;
  lines: string[];
  kind: "add" | "context";
}): WalkthroughExcerpt {
  const end = args.start + args.lines.length - 1;
  return {
    id: `${args.pr}:head:${args.path}#${args.start}-${end}`,
    pr: args.pr,
    path: args.path,
    side: "head",
    start: args.start,
    end,
    language: args.path.endsWith(".sql") ? "sql" : "typescript",
    url: `https://github.com/getsentry/junior/blob/${HEADS[args.pr]}/${args.path}#L${args.start}`,
    lines: args.lines.map((content, index) => {
      const line = args.start + index;
      // Context lines exist on both sides; added lines only on the head.
      return args.kind === "context"
        ? { kind: args.kind, content, newLine: line, oldLine: line }
        : { kind: args.kind, content, newLine: line };
    }),
  };
}

const MIGRATION = excerpt({
  pr: 3090,
  path: "packages/junior/migrations/0101_walkthrough_versions.sql",
  start: 1,
  kind: "add",
  lines: [
    'CREATE TABLE "junior_walkthrough_versions" (',
    '\t"id" uuid PRIMARY KEY NOT NULL,',
    '\t"parent_version_id" uuid,',
    '\t"provider" text NOT NULL,',
  ],
});
const NO_FK_COMMENT = excerpt({
  pr: 3090,
  path: "packages/junior/src/db/schema/walkthroughs.ts",
  start: 48,
  kind: "context",
  lines: [
    "    /**",
    "     * The hidden Conversation whose Turn generates this version. Lists hide",
    "     * Conversations that appear here. No foreign key: the version claims",
    "     * its snapshot before the Conversation exists, so two clicks never",
    "     * create two Conversations.",
    "     */",
    '    generationConversationId: text("generation_conversation_id"),',
  ],
});
const DASHBOARD_ROUTES = excerpt({
  pr: 3133,
  path: "packages/junior/src/dashboard-routes.ts",
  start: 250,
  kind: "context",
  lines: [
    '    "/api/workspaces",',
    '    "/api/workspaces/*",',
    '    "/api/walkthroughs",',
    '    "/api/walkthroughs/*",',
    '    "/api/config",',
  ],
});
const PAGE = excerpt({
  pr: 3147,
  path: "packages/junior-dashboard/src/client/walkthrough/WalkthroughPage.tsx",
  start: 49,
  kind: "add",
  lines: [
    "  const version = query.data;",
    '  if (version.status === "ready" && version.document) {',
    "    return <ReadyWalkthrough document={version.document} version={version} />;",
    "  }",
    "  return <PendingWalkthrough version={version} />;",
  ],
});

const code = (e: WalkthroughExcerpt) => ({
  kind: "code" as const,
  pr: e.pr,
  path: e.path,
  side: "head" as const,
  start: e.start,
  end: e.end,
});

/**
 * An update of the stack fixture, written by hand from what really changed:
 * the migration was renumbered, the routes moved behind the dashboard, and
 * slice 5 joined. #3087 is shown as left the stack so the row renders; it has
 * not merged.
 */
export function mockUpdateDocument(
  base: WalkthroughDocument,
): WalkthroughDocument {
  const layers = base.layers
    .filter((layer) => layer.pr !== 3087)
    .map((layer) => ({ ...layer, headSha: HEADS[layer.pr] ?? layer.headSha }));
  const gone = base.layers.find((layer) => layer.pr === 3087);
  return {
    ...base,
    versionId: MOCK_UPDATE_IDS.update,
    parentVersionId: MOCK_UPDATE_IDS.base,
    contentVersionId: MOCK_UPDATE_IDS.base,
    layers: [
      ...layers,
      {
        pr: 3147,
        title: "feat(walkthroughs): Open a Walkthrough from the dashboard",
        url: "https://github.com/getsentry/junior/pull/3147",
        headSha: HEADS[3147]!,
        baseSha: HEADS[3133]!,
        additions: 2100,
        deletions: 12,
      },
    ],
    excerpts: [
      ...base.excerpts,
      MIGRATION,
      NO_FK_COMMENT,
      DASHBOARD_ROUTES,
      PAGE,
    ],
    updates: [
      {
        versionId: MOCK_UPDATE_IDS.update,
        createdAt: "2026-11-11T06:00:00.000Z",
        changedChapters: ["versions-table", "start-flow"],
        movedLayers: [3088, 3090, 3124, 3133],
        newLayers: [3147],
        leftLayers: gone
          ? [{ pr: gone.pr, title: gone.title, url: gone.url }]
          : [],
        items: [
          {
            id: "versions-renumbered",
            touches: "versions-table",
            answers: "no-fk",
            caption:
              "The migration is now 0101, and the schema says why there is no foreign key.",
            body: "Main took 0100, so the table moved to 0101 with the same SQL [1]. The column comment now says the version claims its snapshot before the Conversation exists [2].",
            evidence: [code(MIGRATION), code(NO_FK_COMMENT)],
            decisions: [],
          },
          {
            id: "routes-behind-dashboard",
            touches: "start-flow",
            caption:
              "The Walkthrough routes now go through the dashboard host.",
            body: "The dashboard host lists the Walkthrough routes, so a click from the dashboard reaches the start route [1].",
            evidence: [code(DASHBOARD_ROUTES)],
            decisions: [],
          },
        ],
        added_chapters: [
          {
            id: "dashboard-page",
            label: "Reading it in the dashboard",
            caption:
              "The dashboard opens a Walkthrough and waits while it is written.",
            role: "other",
            body: "A ready version renders its story, and any other version shows the writing or failed state [1].",
            evidence: [code(PAGE)],
            decisions: [],
            asks: [],
          },
        ],
        also_changed: [],
      },
    ],
  };
}

/** The reviewer's answers on the first version of the lineage. */
export function mockBaseAnswers(): WalkthroughAnswerResponse[] {
  const updatedAt = "2026-11-11T05:00:00.000Z";
  const versionId = MOCK_UPDATE_IDS.base;
  return [
    {
      decisionId: "no-fk",
      versionId,
      value: "change",
      note: "Say in the schema why there is no foreign key.",
      updatedAt,
    },
    { decisionId: "runs-as-clicker", versionId, value: "agree", updatedAt },
    { decisionId: "fork-prs", versionId, value: "agree", updatedAt },
  ];
}

/** The versions list of one mock lineage version. */
export function mockLineage(
  versions: readonly WalkthroughVersionResponse[],
): WalkthroughVersionResponse["versions"] {
  return versions.map((v) => ({
    id: v.id,
    status: v.status,
    createdAt: v.createdAt,
  }));
}
