import { z } from "zod";
import { getDashboardConversationLink } from "@/chat/dashboard-link";
import { getDb } from "@/chat/db";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRegistry } from "@/chat/tools/definition";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { isSpacesEnabled } from "./registration";
import {
  archiveSpace,
  assignConversations,
  createSpace,
  listSpaceConversations,
  mergeSpace,
  moveSpace,
  readConversationSpace,
  readSpaceTree,
  resolveSpaceId,
  type SpaceConversation,
  updateSpace,
} from "./store";
import {
  formatSpacePath,
  MAX_SPACE_DESCRIPTION_CHARS,
  MAX_SPACE_NAME_CHARS,
  SpaceInputError,
  subtreeSpaceIds,
  topLevelSpaceIds,
} from "./tree";
import type { SpaceActor, SpaceNode } from "./types";

/** Deferred tool catalog source for Space tools. */
export const SPACES_TOOL_SOURCE = {
  id: "spaces",
  description:
    "Browse, find, create, rename, move, merge, and archive Spaces (nested forum categories that group Conversations), and move Conversations between them.",
} as const;

const MAX_LIST_SPACES = 300;
const DEFAULT_CONVERSATION_LIMIT = 20;
const MAX_CONVERSATION_LIMIT = 50;

const spaceIdSchema = z.string().trim().min(1).max(64);
const reasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(400)
  .nullable()
  .optional()
  .describe("Why the change helps. Kept in the Space change log.");

const spaceOutputSchema = z
  .object({
    space_id: z.string(),
    parent_space_id: z.string().nullable(),
    name: z.string(),
    path: z.string(),
    description: z.string(),
    depth: z.number().int(),
    child_count: z.number().int(),
    conversation_count: z.number().int(),
    total_conversation_count: z.number().int(),
    last_activity_at: z.string().optional(),
  })
  .strict();

function spaceView(node: SpaceNode): z.output<typeof spaceOutputSchema> {
  return {
    space_id: node.spaceId,
    parent_space_id: node.parentSpaceId ?? null,
    name: node.name,
    path: formatSpacePath(node.path),
    description: node.description,
    depth: node.depth,
    child_count: node.childSpaceIds.length,
    conversation_count: node.conversationCount,
    total_conversation_count: node.totalConversationCount,
    ...(node.lastActivityAtMs !== undefined
      ? { last_activity_at: new Date(node.lastActivityAtMs).toISOString() }
      : undefined),
  };
}

const conversationOutputSchema = z
  .object({
    conversation_id: z.string(),
    space_id: z.string(),
    space_path: z.string(),
    title: z.string().optional(),
    channel_name: z.string().optional(),
    summary: z.string().optional(),
    last_activity_at: z.string(),
    dashboard_url: z.string().optional(),
  })
  .strict();

function conversationView(
  conversation: SpaceConversation,
  tree: ReadonlyMap<string, SpaceNode>,
): z.output<typeof conversationOutputSchema> {
  const dashboardUrl = getDashboardConversationLink(
    conversation.conversationId,
  );
  const space = tree.get(conversation.spaceId);
  return {
    conversation_id: conversation.conversationId,
    space_id: conversation.spaceId,
    space_path: space ? formatSpacePath(space.path) : "",
    ...(conversation.title ? { title: conversation.title } : undefined),
    ...(conversation.channelName
      ? { channel_name: conversation.channelName }
      : undefined),
    ...(conversation.summary ? { summary: conversation.summary } : undefined),
    last_activity_at: new Date(conversation.lastActivityAtMs).toISOString(),
    ...(dashboardUrl ? { dashboard_url: dashboardUrl } : undefined),
  };
}

/** Map tree rule failures to input errors the model can repair. */
async function spaceWrite<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof SpaceInputError) {
      throw new ToolInputError(error.message, { cause: error });
    }
    throw error;
  }
}

async function requireActiveSpaceId(spaceId: string): Promise<string> {
  const resolved = await resolveSpaceId(getDb(), spaceId);
  if (!resolved) {
    throw new ToolInputError(
      `Space ${spaceId} does not exist or is archived. Use listSpaces to find a Space.`,
    );
  }
  return resolved;
}

/**
 * Build the Space tools when Spaces are enabled. Every Conversation gets
 * them, because a person may ask to create or reorganize Spaces from a
 * private Conversation. Tool descriptions keep private details out of Space
 * names; only the automatic classifier is barred from naming Spaces there.
 */
export function createSpaceTools(context: ToolRuntimeContext): ToolRegistry {
  if (!isSpacesEnabled()) return {};
  const actor: SpaceActor = {
    kind: "agent",
    conversationId: context.conversationId,
  };
  // The change log keeps reasons only from public Conversations.
  const loggedReason = (reason: string | null | undefined) =>
    context.conversationPrivacy === "public" && reason ? { reason } : undefined;

  const tools: ToolRegistry = {
    listSpaces: zodTool({
      exposure: "deferred",
      source: SPACES_TOOL_SOURCE,
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description:
        "List Spaces as a tree with ids, paths, descriptions, and Conversation counts. Also returns the Space of the current Conversation. Use this before you assign, create, move, or merge Spaces.",
      inputSchema: z
        .object({
          parent_space_id: spaceIdSchema
            .nullable()
            .optional()
            .describe(
              "List only this Space's subtree. Omit for the whole tree.",
            ),
        })
        .strict(),
      outputSchema: juniorToolOutputSchema.extend({
        current_space_id: z.string().nullable(),
        spaces: z.array(spaceOutputSchema),
      }),
      async execute(input) {
        const db = getDb();
        const tree = await readSpaceTree(db);
        const rootIds = input.parent_space_id
          ? [await requireActiveSpaceId(input.parent_space_id)]
          : topLevelSpaceIds(tree);
        const ids = rootIds.flatMap((spaceId) =>
          subtreeSpaceIds(tree, spaceId),
        );
        const current = await readConversationSpace(db, context.conversationId);
        return {
          current_space_id: current?.spaceId ?? null,
          spaces: ids
            .slice(0, MAX_LIST_SPACES)
            .map((spaceId) => spaceView(tree.get(spaceId)!)),
          ...(ids.length > MAX_LIST_SPACES ? { truncated: true } : undefined),
        };
      },
    }),
    getSpace: zodTool({
      exposure: "deferred",
      source: SPACES_TOOL_SOURCE,
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description:
        "Show one Space: its path, child Spaces, and recent public Conversations with Brief summaries. Private Conversations are only counted.",
      inputSchema: z
        .object({
          space_id: spaceIdSchema,
          include_descendants: z
            .boolean()
            .nullable()
            .optional()
            .describe("Include Conversations from child Spaces. Default true."),
          limit: z
            .number()
            .int()
            .min(1)
            .max(MAX_CONVERSATION_LIMIT)
            .nullable()
            .optional()
            .describe(
              `Maximum Conversations. Default ${DEFAULT_CONVERSATION_LIMIT}.`,
            ),
        })
        .strict(),
      outputSchema: juniorToolOutputSchema.extend({
        space: spaceOutputSchema,
        children: z.array(spaceOutputSchema),
        conversations: z.array(conversationOutputSchema),
        private_conversation_count: z.number().int(),
      }),
      async execute(input) {
        const db = getDb();
        const spaceId = await requireActiveSpaceId(input.space_id);
        const tree = await readSpaceTree(db);
        const space = tree.get(spaceId)!;
        const spaceIds =
          input.include_descendants === false
            ? [spaceId]
            : subtreeSpaceIds(tree, spaceId);
        const listed = await listSpaceConversations(db, {
          spaceIds,
          limit: input.limit ?? DEFAULT_CONVERSATION_LIMIT,
        });
        return {
          space: spaceView(space),
          children: space.childSpaceIds.map((childId) =>
            spaceView(tree.get(childId)!),
          ),
          conversations: listed.conversations.map((conversation) =>
            conversationView(conversation, tree),
          ),
          private_conversation_count: listed.privateCount,
        };
      },
    }),
    findSpaceConversations: zodTool({
      exposure: "deferred",
      source: SPACES_TOOL_SOURCE,
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description:
        "Find public Conversations in Spaces by text in their title or Brief, such as incident or outage. Returns ids and current Spaces, so you can move them with assignConversationSpace.",
      inputSchema: z
        .object({
          query: z.string().trim().min(2).max(200),
          space_id: spaceIdSchema
            .nullable()
            .optional()
            .describe("Search only this Space's subtree. Omit for all Spaces."),
          limit: z
            .number()
            .int()
            .min(1)
            .max(MAX_CONVERSATION_LIMIT)
            .nullable()
            .optional()
            .describe(
              `Maximum Conversations. Default ${DEFAULT_CONVERSATION_LIMIT}.`,
            ),
        })
        .strict(),
      outputSchema: juniorToolOutputSchema.extend({
        conversations: z.array(conversationOutputSchema),
      }),
      async execute(input) {
        const db = getDb();
        const tree = await readSpaceTree(db);
        const rootIds = input.space_id
          ? [await requireActiveSpaceId(input.space_id)]
          : topLevelSpaceIds(tree);
        const listed = await listSpaceConversations(db, {
          spaceIds: rootIds.flatMap((spaceId) =>
            subtreeSpaceIds(tree, spaceId),
          ),
          limit: input.limit ?? DEFAULT_CONVERSATION_LIMIT,
          query: input.query,
        });
        return {
          conversations: listed.conversations.map((conversation) =>
            conversationView(conversation, tree),
          ),
        };
      },
    }),
    createSpace: zodTool({
      exposure: "deferred",
      source: SPACES_TOOL_SOURCE,
      executionMode: "sequential",
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description:
        "Create a Space. Name it like a forum category (1 to 4 words). Put it under the closest existing Space unless it is a broad area. Everyone can see Space names and descriptions, so use the name the person asked for and never private details.",
      inputSchema: z
        .object({
          name: z.string().trim().min(1).max(MAX_SPACE_NAME_CHARS),
          description: z
            .string()
            .trim()
            .max(MAX_SPACE_DESCRIPTION_CHARS)
            .describe("3 to 8 comma-separated keywords, not a sentence."),
          parent_space_id: spaceIdSchema
            .nullable()
            .optional()
            .describe("Parent Space. Omit for a top-level Space."),
          reason: reasonSchema,
        })
        .strict(),
      outputSchema: juniorToolOutputSchema.extend({
        space: spaceOutputSchema,
      }),
      async execute(input) {
        const parentSpaceId = input.parent_space_id
          ? await requireActiveSpaceId(input.parent_space_id)
          : undefined;
        const space = await spaceWrite(() =>
          createSpace(getDb(), {
            name: input.name,
            description: input.description,
            ...(parentSpaceId ? { parentSpaceId } : undefined),
            actor,
            ...loggedReason(input.reason),
          }),
        );
        return { space: spaceView(space) };
      },
    }),
    updateSpace: zodTool({
      exposure: "deferred",
      source: SPACES_TOOL_SOURCE,
      executionMode: "sequential",
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description:
        "Rename a Space or replace its description. Everyone can see them, so never use private details.",
      inputSchema: z
        .object({
          space_id: spaceIdSchema,
          name: z
            .string()
            .trim()
            .min(1)
            .max(MAX_SPACE_NAME_CHARS)
            .nullable()
            .optional(),
          description: z
            .string()
            .trim()
            .max(MAX_SPACE_DESCRIPTION_CHARS)
            .nullable()
            .optional(),
          reason: reasonSchema,
        })
        .strict(),
      outputSchema: juniorToolOutputSchema.extend({
        space: spaceOutputSchema,
      }),
      async execute(input) {
        const spaceId = await requireActiveSpaceId(input.space_id);
        const space = await spaceWrite(() =>
          updateSpace(getDb(), {
            spaceId,
            ...(input.name != null ? { name: input.name } : undefined),
            ...(input.description != null
              ? { description: input.description }
              : undefined),
            actor,
            ...loggedReason(input.reason),
          }),
        );
        return { space: spaceView(space) };
      },
    }),
    moveSpace: zodTool({
      exposure: "deferred",
      source: SPACES_TOOL_SOURCE,
      executionMode: "sequential",
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description:
        "Move a Space, with all its child Spaces and Conversations, under another parent or to the top level.",
      inputSchema: z
        .object({
          space_id: spaceIdSchema,
          parent_space_id: spaceIdSchema
            .nullable()
            .describe("New parent Space, or null for the top level."),
          reason: reasonSchema,
        })
        .strict(),
      outputSchema: juniorToolOutputSchema.extend({
        space: spaceOutputSchema,
      }),
      async execute(input) {
        const spaceId = await requireActiveSpaceId(input.space_id);
        const parentSpaceId = input.parent_space_id
          ? await requireActiveSpaceId(input.parent_space_id)
          : undefined;
        const space = await spaceWrite(() =>
          moveSpace(getDb(), {
            spaceId,
            ...(parentSpaceId ? { parentSpaceId } : undefined),
            actor,
            ...loggedReason(input.reason),
          }),
        );
        return { space: spaceView(space) };
      },
    }),
    mergeSpace: zodTool({
      exposure: "deferred",
      source: SPACES_TOOL_SOURCE,
      executionMode: "sequential",
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description:
        "Merge a Space into another Space. Its child Spaces and Conversations move to the target. The old id keeps resolving to the target.",
      inputSchema: z
        .object({
          space_id: spaceIdSchema.describe("Space to merge away."),
          into_space_id: spaceIdSchema.describe("Space that stays."),
          reason: reasonSchema,
        })
        .strict(),
      outputSchema: juniorToolOutputSchema.extend({
        space: spaceOutputSchema,
        moved_conversations: z.number().int(),
      }),
      async execute(input) {
        const spaceId = await requireActiveSpaceId(input.space_id);
        const intoSpaceId = await requireActiveSpaceId(input.into_space_id);
        const merged = await spaceWrite(() =>
          mergeSpace(getDb(), {
            spaceId,
            intoSpaceId,
            actor,
            ...loggedReason(input.reason),
          }),
        );
        return {
          space: spaceView(merged.target),
          moved_conversations: merged.movedConversations,
        };
      },
    }),
    archiveSpace: zodTool({
      exposure: "deferred",
      source: SPACES_TOOL_SOURCE,
      executionMode: "sequential",
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description:
        "Archive an empty Space. Move or merge its child Spaces and Conversations first.",
      inputSchema: z
        .object({ space_id: spaceIdSchema, reason: reasonSchema })
        .strict(),
      outputSchema: juniorToolOutputSchema.extend({
        archived: z.literal(true),
      }),
      async execute(input) {
        const spaceId = await requireActiveSpaceId(input.space_id);
        await spaceWrite(() =>
          archiveSpace(getDb(), {
            spaceId,
            actor,
            ...loggedReason(input.reason),
          }),
        );
        return { archived: true as const };
      },
    }),
    assignConversationSpace: zodTool({
      exposure: "deferred",
      source: SPACES_TOOL_SOURCE,
      executionMode: "sequential",
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description:
        "Move Conversations to a Space. Defaults to the current Conversation. The automatic classifier never overrides this choice.",
      inputSchema: z
        .object({
          space_id: spaceIdSchema,
          conversation_ids: z
            .array(z.string().trim().min(1))
            .min(1)
            .max(100)
            .nullable()
            .optional()
            .describe("Root Conversation ids. Omit for the current one."),
          reason: reasonSchema,
        })
        .strict(),
      outputSchema: juniorToolOutputSchema.extend({
        space: spaceOutputSchema,
        assigned: z.array(z.string()),
        unchanged: z.array(z.string()),
      }),
      async execute(input) {
        const db = getDb();
        const spaceId = await requireActiveSpaceId(input.space_id);
        const result = await spaceWrite(() =>
          assignConversations(db, {
            conversationIds: input.conversation_ids ?? [context.conversationId],
            spaceId,
            actor,
            pinned: true,
            ...loggedReason(input.reason),
          }),
        );
        const space = (await readSpaceTree(db)).get(spaceId)!;
        return {
          space: spaceView(space),
          assigned: result.assigned,
          unchanged: result.skipped,
        };
      },
    }),
  };
  return tools;
}
