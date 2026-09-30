import type { JuniorDatabase } from "@/db/db";
import type { ConversationBrief } from "@/chat/briefs/schema";
import {
  classifyConversationSpace,
  type SpaceClassification,
  type SpaceClassificationInput,
} from "./classify";
import {
  assignConversations,
  createSpace,
  readConversationSpace,
  readSpaceTree,
  setConversationKind,
} from "./store";
import { findSiblingByName } from "./tree";
import type { SpaceActor, SpaceNode } from "./types";

type ClassifierCompleteObject = Parameters<
  typeof classifyConversationSpace
>[0]["completeObject"];

/** Result of classifying and assigning one Conversation. */
export interface SpaceAssignmentResult {
  space: SpaceNode;
  created: boolean;
  confidence: number;
  costUsd?: number;
}

/**
 * Create the proposed Space when needed, then assign the Conversation. A
 * Space that appeared since classification is reused instead of duplicated.
 */
export async function applySpaceClassification(
  db: JuniorDatabase,
  args: {
    conversationId: string;
    classification: SpaceClassification;
    actor: SpaceActor;
    isPublic: boolean;
    turnId?: string;
  },
): Promise<{ space: SpaceNode; created: boolean }> {
  const { classification } = args;
  const reason = args.isPublic ? classification.reason : undefined;
  let spaceId: string;
  let created = false;
  if (classification.kind === "existing") {
    spaceId = classification.spaceId;
  } else {
    const existing = findSiblingByName(
      await readSpaceTree(db),
      classification.parentSpaceId,
      classification.name,
    );
    if (existing) {
      spaceId = existing.spaceId;
    } else {
      const space = await createSpace(db, {
        name: classification.name,
        description: classification.description,
        ...(classification.parentSpaceId
          ? { parentSpaceId: classification.parentSpaceId }
          : undefined),
        actor: args.actor,
        ...(reason ? { reason } : undefined),
      });
      spaceId = space.spaceId;
      created = true;
    }
  }
  await assignConversations(db, {
    conversationIds: [args.conversationId],
    spaceId,
    actor: args.actor,
    confidence: classification.confidence,
    kind: classification.conversationKind,
    pinned: false,
    ...(args.turnId ? { turnId: args.turnId } : undefined),
    ...(reason ? { reason } : undefined),
  });
  const space = (await readSpaceTree(db)).get(spaceId);
  if (!space) {
    throw new Error(`Space ${spaceId} disappeared during assignment`);
  }
  return { space, created };
}

/**
 * Classify one root Conversation from its latest Brief and assign it. The
 * classifier runs only while the Conversation has no Space, or has a pinned
 * Space with no kind yet. A pinned Space stays; only the kind is recorded.
 * Private Conversations can only join existing Spaces, so their content
 * never names a public Space.
 */
export async function assignSpaceFromBrief(
  db: JuniorDatabase,
  args: {
    conversationId: string;
    turnId: string;
    brief: ConversationBrief;
    conversation: Omit<SpaceClassificationInput, "brief">;
    isPublic: boolean;
    completeObject: ClassifierCompleteObject;
  },
): Promise<SpaceAssignmentResult | undefined> {
  const current = await readConversationSpace(db, args.conversationId);
  if (current && (current.kind || !current.pinned)) {
    return undefined;
  }
  const tree = await readSpaceTree(db);
  if (!args.isPublic && tree.size === 0) {
    return undefined;
  }
  const result = await classifyConversationSpace({
    completeObject: args.completeObject,
    conversation: { ...args.conversation, brief: args.brief },
    tree,
    allowCreate: args.isPublic,
  });
  if (!result.classification) {
    return undefined;
  }
  if (current) {
    await setConversationKind(db, {
      conversationId: args.conversationId,
      kind: result.classification.conversationKind,
    });
    return undefined;
  }
  const applied = await applySpaceClassification(db, {
    conversationId: args.conversationId,
    classification: result.classification,
    actor: { kind: "classifier" },
    isPublic: args.isPublic,
    turnId: args.turnId,
  });
  return {
    ...applied,
    confidence: result.classification.confidence,
    ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : undefined),
  };
}
