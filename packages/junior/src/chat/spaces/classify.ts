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
import {
  CONVERSATION_KINDS,
  type ConversationKind,
  type SpaceNode,
} from "./types";

/** Largest tree shown to the classifier. Deeper Spaces are dropped first. */
const MAX_PROMPT_SPACES = 400;
const PROMPT_DESCRIPTION_CHARS = 160;
const MAX_PROMPT_REPOSITORIES = 5;

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
        "3 to 8 comma-separated keywords for the new Space, such as 'span ingestion, performance issues, detectors'.",
      ),
    kind: z
      .enum(CONVERSATION_KINDS)
      .describe("Kind of work the Conversation was."),
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
  brief: Pick<ConversationBrief, "summary" | "intent" | "keywords"> &
    Partial<Pick<ConversationBrief, "links">>;
}

/** Validated classifier result, with Space ids instead of prompt handles. */
export type SpaceClassification =
  | {
      kind: "existing";
      spaceId: string;
      conversationKind: ConversationKind;
      confidence: number;
      reason: string;
    }
  | {
      kind: "create";
      parentSpaceId?: string;
      name: string;
      description: string;
      conversationKind: ConversationKind;
      confidence: number;
      reason: string;
    };

type CompleteObject = (request: {
  schema: typeof spaceClassificationSchema;
  system: string;
  prompt: string;
  temperature?: number;
}) => Promise<{ costUsd?: number; object: SpaceClassificationOutput }>;

export const SPACE_CLASSIFIER_PROMPT = `You organize an organization's Junior Conversations into Spaces. Spaces are nested forum categories. They mirror how the organization is built and run: code repositories and products first, then product areas, platforms, teams, internal tools, processes, and recurring kinds of work.

Pick the one Space where a person would look for this Conversation later.

Rules:
- Prefer an existing Space. Pick the most specific Space that fits the whole Conversation, not one detail of it.
- Top-level Spaces are code repositories, products, or broad areas of the organization. When the Conversation is about the code, tools, data, or operations of one repository or product, it belongs inside that repository's Space. For example, a backfill of Junior data goes under Junior, not in a top-level Backfills Space.
- Name a repository Space after the repository or product, such as Junior, Sentry, or Relay. Do not add the organization name.
- The Repositories line is the strongest hint for the top-level Space. The channel name is a strong hint for the area. The content decides.
- Create a Space only when no existing Space fits and the topic will likely come up again. Never create a Space for one question, one bug, one person, or one date.
- Create the new Space under the closest existing Space. When the right repository or product Space does not exist yet, create it at the top level first.
- Name a Space like a forum category: 1 to 4 words, Title Case, no punctuation at the ends. Use the common name of a product, area, or kind of work. Do not repeat the parent name.
- The description is 3 to 8 comma-separated keywords. Do not write a sentence. Never start with "Conversations about" or a similar phrase.
- A generic question with no clear area goes to the closest broad Space.
- Kind: question for a quick answer or how-to, investigation for research or debugging without a code change, bug for a bug report or fix, feature for new or changed behavior, task for operational or maintenance work.
- Confidence is how sure you are that people would agree with the choice.
- Spaces can be at most ${MAX_SPACE_DEPTH} levels deep.`;

/** Match `owner/name` in GitHub URLs. */
const GITHUB_REPOSITORY_PATTERN =
  /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)/i;

/** GitHub repositories named by Brief links, most linked first. */
export function briefRepositories(
  links: ReadonlyArray<{ url: string }> | undefined,
): string[] {
  const counts = new Map<string, number>();
  for (const link of links ?? []) {
    const match = GITHUB_REPOSITORY_PATTERN.exec(link.url);
    if (!match) continue;
    const repository = `${match[1]}/${match[2]!.replace(/\.git$/, "")}`;
    counts.set(repository, (counts.get(repository) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([repository]) => repository);
}

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
  const repositories = briefRepositories(input.brief.links).slice(
    0,
    MAX_PROMPT_REPOSITORIES,
  );
  return [
    input.title ? `Title: ${truncate(input.title, 200)}` : undefined,
    input.channelName ? `Channel: ${input.channelName}` : undefined,
    repositories.length > 0
      ? `Repositories: ${repositories.join(", ")}`
      : undefined,
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
  const conversationKind = output.kind;
  const lookup = (handle: string | null): SpaceNode | undefined => {
    const spaceId = handle ? args.handles.get(handle.trim()) : undefined;
    return spaceId ? args.tree.get(spaceId) : undefined;
  };
  if (output.decision === "existing") {
    const space = lookup(output.spaceHandle);
    return space
      ? {
          kind: "existing",
          spaceId: space.spaceId,
          conversationKind,
          confidence,
          reason,
        }
      : undefined;
  }

  const parent = lookup(output.parentHandle);
  const fallback = parent
    ? {
        kind: "existing" as const,
        spaceId: parent.spaceId,
        conversationKind,
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
    return {
      kind: "existing",
      spaceId: sibling.spaceId,
      conversationKind,
      confidence,
      reason,
    };
  }
  return {
    kind: "create",
    ...(parent ? { parentSpaceId: parent.spaceId } : undefined),
    name,
    description,
    conversationKind,
    confidence,
    reason,
  };
}
