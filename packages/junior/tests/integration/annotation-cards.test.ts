import { readConversationDetail } from "@/api/conversations/detail";
import { signedInViewer, testViewer } from "../fixtures/user";
import { getSpaceLead } from "@/chat/lead/conversation";
import { setConversationSpace } from "@/chat/spaces/conversations";
import { createSpace } from "@/chat/spaces/store";
import {
  defineJuniorPlugin,
  definePluginTool,
  pluginToolOutputSchema,
  type ObjectAnnotation,
} from "@sentry/junior-plugin-api";
import { eq } from "drizzle-orm";
import { githubPlugin } from "@sentry/junior-github";
import { http, HttpResponse } from "msw";
import { afterEach, expect, it, vi } from "vitest";
import { patchConfig } from "../fixtures/config";
import { useAppContext } from "../fixtures/app-context";
import { createApp, defineJuniorPlugins } from "@/app";
import * as z from "zod";
import {
  createPluginAnnotations,
  listConversationAnnotations,
} from "@/chat/plugins/annotations";
import {
  getConversationEventStore,
  getConversationStore,
  getDb,
} from "@/chat/db";
import { juniorConversationAnnotations } from "@/db/schema";
import { loadPendingMessageCards } from "@/chat/conversations/pending-cards";
import { sendSlackReply } from "@/chat/slack/reply";
import {
  closeConversationFixture,
  createConversationWebHarness,
} from "../fixtures/conversation";
import {
  GITHUB_API,
  GITHUB_REPO,
  linkGitHubMember,
  pullRequest,
  stubGitHubApp,
} from "../fixtures/github-objects";
import { createModelStream } from "../fixtures/model-stream";
import { mswServer } from "../msw/server";
import { getCapturedSlackApiCalls } from "../msw/handlers/slack-api";

// What the tool saves. The card reads the rest from the link type.
const annotation = {
  kind: "object" as const,
  objectType: "code_change" as const,
  key: "repo#1",
  title: "Fix the parser",
  url: "https://example.com/pull/1",
};

const card: ObjectAnnotation = {
  ...annotation,
  label: "repo#1",
  description: `Fix **parsing**. ${"More context. ".repeat(50)}`,
  status: "open",
  sourceUpdatedAt: "2026-09-25T12:00:00Z",
  facts: {
    type: "code_change",
    author: "alex",
    reviewers: ["sam"],
    review: "required",
    checks: { passed: 1, failed: 0, pending: 2 },
    mergeable: true,
    additions: 20,
    deletions: 5,
    sourceBranch: "feature/parser",
    targetBranch: "main",
    changedFiles: 2,
  },
};

// Built outside the tool definition, as a shared helper would be, so only
// core's runtime check stops it.
const readResult = () => ({
  objectAnnotations: [
    {
      ...annotation,
      action: "changed" as const,
      key: "repo#2",
    },
  ],
});

afterEach(closeConversationFixture);

it("saves plugin object results once per reply, rejects them from reads, leaves background updates silent, and stores only Message card references", async () => {
  const saveInputs: unknown[] = [];
  // What the provider shows now. Undefined means the provider is down.
  let liveStatus: string | undefined = "draft";
  useAppContext({
    plugins: [
      defineJuniorPlugin({
        manifest: {
          name: "objects",
          displayName: "Objects",
          description: "Object test tools",
        },
        inboxSubjects: [
          { kind: "change", label: "Change", owner: "annotation" },
        ],
        objectLinks: [
          {
            objectTypes: ["code_change"],
            filters: [{ host: "example.com", pathPattern: "/pull/*" }],
            canView: async () => true,
            label: (url) => `repo#${url.pathname.split("/").at(-1)}`,
            resolve: async () => {
              if (!liveStatus) throw new Error("Provider is down");
              return { ...card, status: liveStatus };
            },
          },
        ],
        hooks: {
          tools: () => ({
            save: definePluginTool({
              approvalMode: "approve",
              exposure: "direct",
              annotations: {
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
                readOnlyHint: false,
              },
              description: "Return a verified object for this test.",
              inputSchema: z.object({
                fail: z.boolean().optional(),
                timed_out: z.boolean().optional(),
                status: z.string().optional(),
              }),
              outputSchema: pluginToolOutputSchema,
              execute: (input) => {
                saveInputs.push(input);
                const { fail, timed_out, status } = input;
                if (fail) throw new Error("Object update failed");
                return {
                  timed_out,
                  objectAnnotations: [
                    {
                      ...annotation,
                      // The first save creates it. Later saves change it.
                      action:
                        status === "open"
                          ? ("created" as const)
                          : ("changed" as const),
                      subject: { id: "1", kind: "change" },
                    },
                  ],
                };
              },
            }),
            read: definePluginTool({
              approvalMode: "approve",
              exposure: "direct",
              annotations: {
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
                readOnlyHint: true,
              },
              description: "Read an object for this test.",
              inputSchema: z.object({}),
              outputSchema: pluginToolOutputSchema,
              execute: readResult,
            }),
          }),
        },
      }),
    ],
  });
  patchConfig({
    dashboard: {
      baseURL: "https://junior.example.com",
      basePath: "/ops",
    },
  });
  const harness = await createConversationWebHarness(
    createModelStream([
      {
        type: "toolCall",
        name: "executeTool",
        // callMcpTool takes a top-level intent too, so models send it here.
        arguments: {
          tool_name: "objects_save",
          arguments: { status: "open" },
          intent: "show the object",
        },
      },
      // A read must not save an Annotation, so core rejects its result.
      { type: "toolCall", name: "objects_read", arguments: {} },
      {
        type: "toolCall",
        // PR creation is a direct plugin tool, not a catalog call.
        name: "objects_save",
        arguments: { status: "draft" },
      },
      {
        type: "toolCall",
        name: "executeTool",
        arguments: {
          tool_name: "objects_save",
          arguments: { status: "closed", timed_out: true },
        },
      },
      {
        type: "toolCall",
        name: "executeTool",
        arguments: { tool_name: "objects_save", arguments: { fail: true } },
      },
      { type: "text", text: "The object is ready; the later update failed." },
    ]),
  );
  const { conversationId } = await harness.start({
    idempotencyKey: "objects-1",
    message: "Show the object.",
  });
  await harness.drain();
  expect(saveInputs[0]).toEqual({ status: "open" });
  const history = await getConversationEventStore().loadHistory(conversationId);
  const message = history.find(
    (event) => event.data.type === "message" && event.data.role === "assistant",
  );
  const cards = [{ ...card, plugin: "objects", status: "draft" }];
  const refs = [{ kind: "object", plugin: "objects", key: annotation.key }];
  if (!message || message.data.type !== "message")
    throw new Error("Expected an assistant Message");
  expect(message.data.meta?.["objectCards"]).toEqual(refs);
  expect(message.data.meta).not.toHaveProperty("cards");
  const toolResults = history
    .map((event) => event.data)
    .filter((data) => data.type === "tool_result");
  for (const result of toolResults) {
    expect(result["details"]).not.toHaveProperty("cards");
  }
  const selectedResults = toolResults.filter(
    (result) =>
      result["details"] &&
      typeof result["details"] === "object" &&
      "objectCards" in result["details"],
  );
  expect(selectedResults).toHaveLength(2);
  expect(JSON.stringify(toolResults)).toContain(
    "Read-only objects tool returned objectAnnotations",
  );
  for (const result of selectedResults) {
    expect(result["details"]).not.toHaveProperty("objectAnnotations");
  }

  // The Annotation stores no state: the card reads it live.
  const stored = await listConversationAnnotations(getDb(), conversationId);
  expect(stored).toMatchObject([{ ...annotation, plugin: "objects" }]);
  expect(JSON.stringify(stored)).not.toMatch(/draft|status|label|facts/);
  // The row names the object by its subject. A later change keeps
  // `created`, because the Conversation still created the object.
  await expect(
    getDb()
      .select({
        action: juniorConversationAnnotations.action,
        subjectId: juniorConversationAnnotations.subjectId,
        subjectKind: juniorConversationAnnotations.subjectKind,
      })
      .from(juniorConversationAnnotations)
      .where(eq(juniorConversationAnnotations.conversationId, conversationId)),
  ).resolves.toEqual([
    { action: "created", subjectId: "1", subjectKind: "objects:change" },
  ]);
  await expect(loadPendingMessageCards(conversationId)).resolves.toEqual([]);
  await sendSlackReply({
    channelId: "C123",
    conversationId,
    text: "The object is ready.",
    cards,
  });
  expect(
    getCapturedSlackApiCalls("chat.postMessage").at(-1)?.params["metadata"],
  ).toEqual({
    entities: [
      {
        entity_type: "slack#/entities/item",
        external_ref: {
          id: expect.stringMatching(/^[A-Za-z0-9_-]{1,128}$/),
          type: "annotation",
        },
        url: annotation.url,
        entity_payload: {
          attributes: {
            title: { text: "Fix the parser" },
            display_id: "repo#1",
            display_type: "Code change",
            product_icon: {
              url: "https://junior.example.com/_junior/dashboard/object-icons/v1/git-pull-request-draft.png",
              alt_text: "Code change",
            },
            product_name: "objects",
          },
          display_order: ["description"],
          custom_fields: [
            {
              key: "description",
              label: "Description",
              type: "string",
              value: `${card.description!.slice(0, 499).trimEnd()}…`,
              long: true,
              format: "markdown",
            },
          ],
        },
      },
    ],
  });

  const mixedCards = [
    {
      ...card,
      plugin: "objects",
      status: "closed",
      facts: undefined,
      description: "One\nTwo\nThree\nFour\nFive\nSix\nSeven",
    },
    {
      ...card,
      plugin: "objects",
      key: "issue-1",
      description: undefined,
      objectType: "task" as const,
      status: "closed",
      facts: { type: "task" as const, assignees: ["Sam"], priority: "High" },
    },
    {
      ...card,
      plugin: "objects",
      key: "deploy-1",
      description: "  ",
      // Saved deployments used Item before Deployment became a native type.
      objectType: "item" as const,
      status: "ERROR",
      warning: "Deployment failed",
      facts: {
        type: "deployment" as const,
        environment: "production",
        project: "app",
        revision: "abc123",
        branch: "main",
      },
    },
    {
      ...card,
      plugin: "objects",
      key: "event-1",
      label: "Oct 12",
      description: "Agenda stays in the detail panel.",
      objectType: "calendar_event" as const,
      status: "cancelled",
      facts: {
        type: "calendar_event" as const,
        when: "Mon, Oct 12, 10:00 – 10:30 PDT",
        attendees: ["Sam", "Alex"],
      },
    },
    {
      ...card,
      plugin: "junior",
      key: "daily",
      objectType: "automation" as const,
      trigger: "Every day",
      status: "blocked",
      warning: "Reconnect provider",
      facts: undefined,
    },
  ];
  await sendSlackReply({
    channelId: "C123",
    conversationId,
    text: "Linked work",
    cards: mixedCards,
  });
  const mixedPost = getCapturedSlackApiCalls("chat.postMessage").at(-1)?.params;
  expect(mixedPost?.["metadata"]).toMatchObject({
    entities: [
      {
        entity_type: "slack#/entities/item",
        entity_payload: {
          attributes: {
            display_type: "Code change",
            product_icon: {
              url: "https://junior.example.com/_junior/dashboard/object-icons/v1/git-pull-request-closed.png",
            },
          },
          custom_fields: [
            {
              key: "description",
              value: "One\nTwo\nThree\nFour\nFive\nSix…",
            },
          ],
        },
      },
      {
        entity_type: "slack#/entities/task",
        entity_payload: {
          attributes: {
            display_type: "Ticket",
            product_icon: {
              url: "https://junior.example.com/_junior/dashboard/object-icons/v1/issue-closed.png",
            },
          },
          custom_fields: [],
        },
      },
      {
        entity_type: "slack#/entities/item",
        entity_payload: {
          attributes: {
            display_type: "Deployment",
            product_icon: {
              url: "https://junior.example.com/_junior/dashboard/object-icons/v1/rocket.png",
            },
          },
          custom_fields: [
            { key: "status", value: "ERROR" },
            { key: "environment", value: "production" },
            { key: "warning", value: "Deployment failed" },
          ],
        },
      },
      {
        entity_type: "slack#/entities/item",
        entity_payload: {
          attributes: {
            display_id: "Oct 12",
            display_type: "Calendar event",
            product_icon: {
              url: "https://junior.example.com/_junior/dashboard/object-icons/v1/calendar.png",
            },
          },
          custom_fields: [
            { key: "status", value: "cancelled" },
            { key: "when", value: "Mon, Oct 12, 10:00 – 10:30 PDT" },
            { key: "attendees", value: "Sam, Alex" },
          ],
        },
      },
      {
        entity_type: "slack#/entities/item",
        entity_payload: {
          attributes: {
            display_type: "Automation",
            product_icon: {
              url: "https://junior.example.com/_junior/dashboard/object-icons/v1/workflow.png",
            },
          },
          custom_fields: [
            { key: "trigger", value: "Every day" },
            { key: "warning", value: "Reconnect provider" },
          ],
        },
      },
    ],
  });
  expect(JSON.stringify(mixedPost)).not.toContain('"fields"');
  for (const hidden of [
    "Assignees:",
    "Priority:",
    "Revision:",
    "Branch:",
    "blocked",
    "Agenda",
  ])
    expect(mixedPost?.["text"]).not.toContain(hidden);
  for (const type of [
    "Code change",
    "Ticket",
    "Deployment",
    "Calendar event",
    "Automation",
  ])
    expect(mixedPost?.["text"]).toContain(type);
  patchConfig({ dashboard: undefined });
  await sendSlackReply({
    channelId: "C123",
    conversationId,
    text: "Linked work",
    cards: [mixedCards[0]!, { ...mixedCards[1]!, url: null }],
  });
  const headless = getCapturedSlackApiCalls("chat.postMessage").at(-1)?.params;
  expect(headless?.["metadata"]).toMatchObject({
    entities: [
      { entity_payload: { attributes: { display_type: "Code change" } } },
    ],
  });
  expect(JSON.stringify(headless?.["metadata"])).not.toContain("product_icon");
  expect(headless?.["text"]).toContain("Ticket");
  patchConfig({
    dashboard: {
      baseURL: "https://junior.example.com",
      basePath: "/ops",
    },
  });

  // The provider merged the object. No Annotation write follows it.
  liveStatus = "merged";
  await expect(loadPendingMessageCards(conversationId)).resolves.toEqual([]);
  const saved = await getConversationEventStore().loadHistory(conversationId);
  expect(saved.find((event) => event.seq === message?.seq)?.data).toMatchObject(
    { meta: { objectCards: refs } },
  );

  expect(saved.filter((event) => event.data.type === "tool_result")).toEqual(
    history.filter((event) => event.data.type === "tool_result"),
  );
  // A page load reads no provider. This link type cannot read only its
  // cache, so the page shows the stored title, the label, and the link,
  // also with the provider down.
  liveStatus = undefined;
  const detail = await readConversationDetail(conversationId, {
    viewer: testViewer(harness.actor.email),
  });
  expect(detail?.annotations).toEqual([
    {
      kind: "object",
      key: annotation.key,
      label: "repo#1",
      objectType: "code_change",
      plugin: "objects",
      title: annotation.title,
      url: annotation.url,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    },
  ]);
  const reported = detail?.events.find((event) => event.seq === message.seq);
  if (reported?.data.type !== "message")
    throw new Error("Expected a reported Message");
  expect(reported.data.cards).toEqual(refs);
  liveStatus = "merged";

  harness.setModelStream(
    createModelStream([{ type: "text", text: "The object has merged." }]),
  );
  await harness.continue({
    conversationId,
    idempotencyKey: "objects-2",
    message: "Any news?",
  });
  await harness.drain();
  const later = (await getConversationEventStore().loadHistory(conversationId))
    .filter(
      (event) =>
        event.data.type === "message" && event.data.role === "assistant",
    )
    .at(-1);
  expect(later?.data).not.toHaveProperty("meta.objectCards");

  harness.setModelStream(
    createModelStream([
      {
        type: "toolCall",
        name: "executeTool",
        arguments: { tool_name: "objects_save", arguments: {} },
      },
      { type: "toolCall", name: "noReply", arguments: {} },
    ]),
  );
  await harness.continue({
    conversationId,
    idempotencyKey: "objects-3",
    message: "Keep this turn silent.",
  });
  await harness.drain();
  harness.setModelStream(
    createModelStream([{ type: "text", text: "Nothing new." }]),
  );
  await harness.continue({
    conversationId,
    idempotencyKey: "objects-4",
    message: "Any news?",
  });
  await harness.drain();
  const last = (await getConversationEventStore().loadHistory(conversationId))
    .filter(
      (event) =>
        event.data.type === "message" && event.data.role === "assistant",
    )
    .at(-1);
  expect(last?.data).not.toHaveProperty("meta.objectCards");
});

it("reads each delivered card once with the access of the person who started the Conversation, and posts only the title, label, and link when it cannot read it", async () => {
  stubGitHubApp();
  let githubUp = false;
  mswServer.use(
    http.get(`${GITHUB_API}/pulls/38`, () =>
      githubUp
        ? HttpResponse.json(
            pullRequest(38, {
              merged: true,
              state: "closed",
              title: "Retry uploads",
            }),
          )
        : HttpResponse.json({ message: "Unavailable" }, { status: 503 }),
    ),
  );
  try {
    await createApp({ plugins: defineJuniorPlugins([githubPlugin()]) });
    // Alice starts the Conversation. She sees the repository on GitHub.
    await linkGitHubMember();
    const conversationId = "slack:CALICE:1712345.0038";
    await getConversationStore().recordActivity({
      actor: { platform: "slack", slackUserId: "UALICE", teamId: "T123" },
      conversationId,
      destination: { channelId: "CALICE", platform: "slack", teamId: "T123" },
      nowMs: Date.now(),
      source: "slack",
      visibility: "public",
    });
    const saved = {
      kind: "object" as const,
      objectType: "code_change" as const,
      key: "getsentry/junior#38",
      title: "Draft: retry uploads",
      url: `${GITHUB_REPO}/pull/38`,
    };
    await createPluginAnnotations({
      conversationId,
      plugin: "github",
      db: getDb(),
    }).upsert(saved);
    // The Turn that opened the pull request selected its card.
    await getConversationEventStore().append(conversationId, [
      {
        createdAtMs: Date.now(),
        data: {
          type: "turn_started",
          turnId: "turn-38",
          inputMessageIds: ["msg-38"],
          surface: "slack",
        },
      },
      {
        createdAtMs: Date.now(),
        data: {
          type: "tool_result",
          toolName: "github_createPullRequest",
          details: {
            objectCards: [{ kind: "object", plugin: "github", key: saved.key }],
          },
        },
      },
    ]);

    // GitHub is down, so the card posts the title, GitHub's label, and the
    // link that Junior saved.
    await expect(loadPendingMessageCards(conversationId)).resolves.toEqual([
      { ...saved, label: "getsentry/junior#38", plugin: "github" },
    ]);
    githubUp = true;
    await expect(loadPendingMessageCards(conversationId)).resolves.toEqual([
      expect.objectContaining({
        key: saved.key,
        label: "getsentry/junior#38",
        plugin: "github",
        status: "merged",
        title: "Retry uploads",
      }),
    ]);
    // Bo moves the thread into a Space that Bo created. Bo cannot see the
    // repository, but the card still reads with Alice's access.
    const bo = await signedInViewer("bo@example.com");
    const space = await createSpace({
      creator: bo,
      description: null,
      name: "Uploads",
      visibility: "public",
    });
    const lead = await getSpaceLead(space.id);
    await expect(
      setConversationSpace(
        conversationId,
        { leadConversationId: lead.conversationId, spaceId: space.id },
        null,
      ),
    ).resolves.toBeUndefined();
    await expect(loadPendingMessageCards(conversationId)).resolves.toEqual([
      expect.objectContaining({ status: "merged", title: "Retry uploads" }),
    ]);
    // Delivery stores nothing: the Annotation keeps what the tool saved.
    await expect(
      listConversationAnnotations(getDb(), conversationId),
    ).resolves.toMatchObject([{ title: saved.title }]);
  } finally {
    vi.unstubAllEnvs();
  }
});
