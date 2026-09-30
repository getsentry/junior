import type { Space, SpaceNode } from "./types";

/** Deepest allowed Space. A top-level Space has depth 1. */
export const MAX_SPACE_DEPTH = 6;
export const MAX_SPACE_NAME_CHARS = 60;
export const MAX_SPACE_DESCRIPTION_CHARS = 400;

/** Separator used when a Space path is shown as one string. */
export const SPACE_PATH_SEPARATOR = " › ";

/** Thrown when a requested Space change breaks a tree rule. */
export class SpaceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpaceInputError";
  }
}

/** Collapse whitespace and validate one Space name. */
export function normalizeSpaceName(name: string): string {
  const normalized = name.replace(/\s+/g, " ").trim();
  if (!normalized) {
    throw new SpaceInputError("Space name must not be empty");
  }
  if (normalized.length > MAX_SPACE_NAME_CHARS) {
    throw new SpaceInputError(
      `Space name must be at most ${MAX_SPACE_NAME_CHARS} characters`,
    );
  }
  if (normalized.includes(SPACE_PATH_SEPARATOR.trim())) {
    throw new SpaceInputError(
      `Space name must not contain "${SPACE_PATH_SEPARATOR.trim()}"`,
    );
  }
  return normalized;
}

/** Collapse whitespace and cap one Space description. */
export function normalizeSpaceDescription(description: string): string {
  const normalized = description.replace(/\s+/g, " ").trim();
  if (normalized.length > MAX_SPACE_DESCRIPTION_CHARS) {
    throw new SpaceInputError(
      `Space description must be at most ${MAX_SPACE_DESCRIPTION_CHARS} characters`,
    );
  }
  return normalized;
}

/** Show a Space path as one string, for example `SDKs › JavaScript`. */
export function formatSpacePath(path: readonly string[]): string {
  return path.join(SPACE_PATH_SEPARATOR);
}

/**
 * Build the active Space tree with paths, depths, and Conversation counts.
 * A Space whose parent is missing from `spaces` is treated as top-level.
 * The returned map iterates in depth-first display order.
 */
export function buildSpaceTree(
  spaces: readonly Space[],
  activity: ReadonlyMap<
    string,
    { conversationCount: number; lastActivityAtMs?: number }
  > = new Map(),
): Map<string, SpaceNode> {
  const byId = new Map(spaces.map((space) => [space.spaceId, space]));
  const children = new Map<string, string[]>();
  for (const space of spaces) {
    const parentId =
      space.parentSpaceId && byId.has(space.parentSpaceId)
        ? space.parentSpaceId
        : "";
    const siblings = children.get(parentId) ?? [];
    siblings.push(space.spaceId);
    children.set(parentId, siblings);
  }
  const byName = (left: string, right: string) =>
    byId.get(left)!.name.localeCompare(byId.get(right)!.name);
  for (const siblings of children.values()) siblings.sort(byName);

  const nodes = new Map<string, SpaceNode>();
  const order: string[] = [];
  const visit = (spaceId: string, parentPath: string[]): SpaceNode => {
    order.push(spaceId);
    const space = byId.get(spaceId)!;
    const path = [...parentPath, space.name];
    const childSpaceIds = children.get(spaceId) ?? [];
    const own = activity.get(spaceId);
    let total = own?.conversationCount ?? 0;
    let lastActivityAtMs = own?.lastActivityAtMs;
    for (const childId of childSpaceIds) {
      const child = visit(childId, path);
      total += child.totalConversationCount;
      if (
        child.lastActivityAtMs !== undefined &&
        (lastActivityAtMs === undefined ||
          child.lastActivityAtMs > lastActivityAtMs)
      ) {
        lastActivityAtMs = child.lastActivityAtMs;
      }
    }
    const node: SpaceNode = {
      ...space,
      path,
      depth: path.length,
      childSpaceIds,
      conversationCount: own?.conversationCount ?? 0,
      totalConversationCount: total,
      ...(lastActivityAtMs !== undefined ? { lastActivityAtMs } : undefined),
    };
    nodes.set(spaceId, node);
    return node;
  };
  for (const rootId of children.get("") ?? []) visit(rootId, []);
  // Iteration order is depth-first display order: parents before children.
  return new Map(order.map((spaceId) => [spaceId, nodes.get(spaceId)!]));
}

/** Return top-level Space ids in display order. */
export function topLevelSpaceIds(
  tree: ReadonlyMap<string, SpaceNode>,
): string[] {
  return [...tree.values()]
    .filter((node) => node.depth === 1)
    .map((node) => node.spaceId);
}

/** Return a Space and every descendant id, parent first. */
export function subtreeSpaceIds(
  tree: ReadonlyMap<string, SpaceNode>,
  spaceId: string,
): string[] {
  const node = tree.get(spaceId);
  if (!node) return [];
  return [
    spaceId,
    ...node.childSpaceIds.flatMap((childId) => subtreeSpaceIds(tree, childId)),
  ];
}

/** Return the number of levels below and including this Space. */
export function subtreeHeight(
  tree: ReadonlyMap<string, SpaceNode>,
  spaceId: string,
): number {
  const node = tree.get(spaceId);
  if (!node) return 0;
  return (
    1 +
    Math.max(
      0,
      ...node.childSpaceIds.map((childId) => subtreeHeight(tree, childId)),
    )
  );
}

/** Find an active sibling by name without case differences. */
export function findSiblingByName(
  tree: ReadonlyMap<string, SpaceNode>,
  parentSpaceId: string | undefined,
  name: string,
): SpaceNode | undefined {
  const lower = name.toLowerCase();
  for (const node of tree.values()) {
    if (
      (node.parentSpaceId ?? undefined) === parentSpaceId &&
      node.name.toLowerCase() === lower
    ) {
      return node;
    }
  }
  return undefined;
}
