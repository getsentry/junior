/** Lifecycle of one Space. Merged and archived Spaces stay for history. */
export type SpaceStatus = "active" | "merged" | "archived";

/** Who changed the Space tree or an assignment. */
export type SpaceActorKind = "classifier" | "agent" | "backfill";

/** One kind of append-only Space change. */
export type SpaceChangeKind =
  | "create"
  | "update"
  | "move"
  | "merge"
  | "archive"
  | "assign";

/** Actor recorded with each Space change. */
export interface SpaceActor {
  kind: SpaceActorKind;
  /** Conversation where the change was requested, when known. */
  conversationId?: string;
}

/** One active Space in the current tree. */
export interface Space {
  spaceId: string;
  parentSpaceId?: string;
  name: string;
  description: string;
  createdAtMs: number;
  updatedAtMs: number;
}

/** One active Space with its place in the tree and Conversation counts. */
export interface SpaceNode extends Space {
  /** Names from the top-level Space to this Space. */
  path: string[];
  depth: number;
  childSpaceIds: string[];
  /** Conversations assigned directly to this Space. */
  conversationCount: number;
  /** Conversations assigned to this Space or any descendant. */
  totalConversationCount: number;
  lastActivityAtMs?: number;
}
