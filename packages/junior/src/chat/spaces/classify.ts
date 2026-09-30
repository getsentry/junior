import { z } from "zod";
import type { ConversationBrief } from "@/chat/briefs/schema";
import {
  findSiblingByName,
  MAX_SPACE_DEPTH,
  MAX_SPACE_DESCRIPTION_CHARS,
  MAX_SPACE_NAME_CHARS,
  normalizeSpaceDescription,
  normalizeSpaceName,
  SpaceInputError,
} from "./tree";
import type { SpaceNode } from "./types";

/** Largest tree shown to the classifier. Deeper Spaces are dropped first. */
const MAX_PROMPT_SPACES = 400;
const PROMPT_DESCRIPTION_CHARS = 160;

/** Classifier output. It is flat and nullable so strict providers accept it. */
export const spaceClassificationSchema = z
  .object({
    decision: z.enum(["existing", "create"]),
    spaceHandle: z
      .string()
      .nullable()
      .describe("Handle such as S3 of the chosen Space, for existing."),
    parentHandle: z
      .string()
      .nullable()
      .describe("Handle of the parent for create, or null for top level."),
    name: z
      .string()
      .nullable()
      .describe(
        `New Space name for create, at most ${MAX_SPACE_NAME_CHARS} characters.`,
      ),
    description: z
      .string()
      .nullable()
      .describe(
        "One sentence that says which Conversations belong in the new Space.",
      ),
    confidence: z.number().min(0).max(1),
    reason: z.string().describe("One short sentence."),
  })
  .strict();

export type SpaceClassificationOutput = z.output<
  typeof spaceClassificationSchema
>;

/** What the classifier knows about one Conversation. */
export interface SpaceClassificationInput {
  title?: string;
  channelName?: string;
  brief: Pick<ConversationBrief, "summary" | "intent" | "keywords">;
}

/** Validated classifier result, with Space ids instead of prompt handles. */
export type SpaceClassification =
  | {
      kind: "existing";
      spaceId: string;
      confidence: number;
      reason: string;
    }
  | {
      kind: "create";
      parentSpaceId?: string;
      name: string;
      description: string;
      confidence: number;
      reason: string;
    };

type CompleteObject = (request: {
  schema: typeof spaceClassificationSchema;
  system: string;
  prompt: string;
  temperature?: number;
}) => Promise<{ costUsd?: number; object: SpaceClassificationOutput }>;

export const SPACE_CLASSIFIER_PROMPT = `You organize an organization's Junior Conversations into Spaces. Spaces are nested forum categories. They mirror how the organization is built and run: products, product areas, platforms, teams, internal tools, processes, and recurring kinds of work.

Pick the one Space where a person would look for this Conversation later.

Rules:
- Prefer an existing Space. Pick the most specific Space that fits the whole Conversation, not one detail of it.
- Create a Space only when no existing Space fits and the topic will likely come up again. Never create a Space for one question, one bug, one person, or one date.
- Create the new Space under the closest existing Space. Create a top-level Space only for a broad area of the organization.
- Name a Space like a forum category: 1 to 4 words, Title Case, no punctuation at the ends. Use the common name of a product, area, or kind of work. Do not repeat the parent name.
- The description says which Conversations belong in the Space, in one sentence.
- The channel name is a strong hint for the area, but the content decides.
- A generic question with no clear area goes to the closest broad Space.
- Confidence is how sure you are that people would agree with the choice.
- Spaces can be at most ${MAX_SPACE_DEPTH} levels deep.`;

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** Choose which Spaces the prompt shows, shallow Spaces first. */
function promptSpaces(tree: ReadonlyMap<string, SpaceNode>): SpaceNode[] {
  const nodes = [...tree.values()];
  if (nodes.length <= MAX_PROMPT_SPACES) return nodes;
  const kept = new Set(
    [...nodes]
      .sort(
        (left, right) =>
          left.depth - right.depth ||
          right.totalConversationCount - left.totalConversationCount,
      )
      .slice(0, MAX_PROMPT_SPACES)
      .map((node) => node.spaceId),
  );
  return nodes.filter((node) => kept.has(node.spaceId));
}

/** Render the tree as an indented outline with short handles. */
export function renderSpaceOutline(tree: ReadonlyMap<string, SpaceNode>): {
  handles: Map<string, string>;
  text: string;
} {
  const shown = new Set(promptSpaces(tree).map((node) => node.spaceId));
  const handles = new Map<string, string>();
  const lines: string[] = [];
  // `tree` iterates in depth-first display order.
  for (const node of tree.values()) {
    if (!shown.has(node.spaceId)) continue;
    const handle = `S${handles.size + 1}`;
    handles.set(handle, node.spaceId);
    const description = node.description
      ? `: ${truncate(node.description, PROMPT_DESCRIPTION_CHARS)}`
      : "";
    lines.push(
      `${"  ".repeat(node.depth - 1)}- ${handle} ${node.name} (${node.totalConversationCount})${description}`,
    );
  }
  return {
    handles,
    text: lines.length > 0 ? lines.join("\n") : "(no Spaces yet)",
  };
}

function renderConversation(input: SpaceClassificationInput): string {
  return [
    input.title ? `Title: ${truncate(input.title, 200)}` : undefined,
    input.channelName ? `Channel: ${input.channelName}` : undefined,
    `Intent: ${input.brief.intent}`,
    `Summary: ${input.brief.summary}`,
    input.brief.keywords.length > 0
      ? `Keywords: ${input.brief.keywords.join(", ")}`
      : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function clampConfidence(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/**
 * Pick or propose one Space for a Conversation. The function is pure: the
 * caller binds the model and applies the result.
 *
 * When `allowCreate` is false, a create proposal falls back to its parent.
 * With no parent, the result is undefined and the Conversation stays
 * unassigned.
 */
export async function classifyConversationSpace(args: {
  completeObject: CompleteObject;
  conversation: SpaceClassificationInput;
  tree: ReadonlyMap<string, SpaceNode>;
  allowCreate: boolean;
  prompt?: string;
}): Promise<{
  classification?: SpaceClassification;
  costUsd?: number;
}> {
  const outline = renderSpaceOutline(args.tree);
  const prompt = [
    "<spaces>",
    outline.text,
    "</spaces>",
    "",
    "<conversation>",
    renderConversation(args.conversation),
    "</conversation>",
    args.allowCreate
      ? ""
      : "\nThis Conversation is private. Pick an existing Space. Do not create one.",
  ].join("\n");
  const result = await args.completeObject({
    schema: spaceClassificationSchema,
    system: args.prompt ?? SPACE_CLASSIFIER_PROMPT,
    prompt,
    temperature: 0,
  });
  const cost =
    result.costUsd !== undefined ? { costUsd: result.costUsd } : undefined;
  const classification = interpretClassification({
    output: result.object,
    handles: outline.handles,
    tree: args.tree,
    allowCreate: args.allowCreate,
  });
  return {
    ...(classification ? { classification } : undefined),
    ...cost,
  };
}

/** Map handles to ids and enforce tree rules on classifier output. */
export function interpretClassification(args: {
  output: SpaceClassificationOutput;
  handles: ReadonlyMap<string, string>;
  tree: ReadonlyMap<string, SpaceNode>;
  allowCreate: boolean;
}): SpaceClassification | undefined {
  const { output } = args;
  const confidence = clampConfidence(output.confidence);
  const reason = truncate(output.reason.trim(), 400);
  const lookup = (handle: string | null): SpaceNode | undefined => {
    const spaceId = handle ? args.handles.get(handle.trim()) : undefined;
    return spaceId ? args.tree.get(spaceId) : undefined;
  };
  if (output.decision === "existing") {
    const space = lookup(output.spaceHandle);
    return space
      ? { kind: "existing", spaceId: space.spaceId, confidence, reason }
      : undefined;
  }

  const parent = lookup(output.parentHandle);
  const fallback = parent
    ? {
        kind: "existing" as const,
        spaceId: parent.spaceId,
        confidence,
        reason,
      }
    : undefined;
  if (!args.allowCreate || (parent && parent.depth >= MAX_SPACE_DEPTH)) {
    return fallback;
  }
  let name: string;
  let description: string;
  try {
    name = normalizeSpaceName(output.name ?? "");
    description = normalizeSpaceDescription(
      truncate(output.description ?? "", MAX_SPACE_DESCRIPTION_CHARS),
    );
  } catch (error) {
    if (error instanceof SpaceInputError) return fallback;
    throw error;
  }
  const sibling = findSiblingByName(args.tree, parent?.spaceId, name);
  if (sibling) {
    return { kind: "existing", spaceId: sibling.spaceId, confidence, reason };
  }
  return {
    kind: "create",
    ...(parent ? { parentSpaceId: parent.spaceId } : undefined),
    name,
    description,
    confidence,
    reason,
  };
}
