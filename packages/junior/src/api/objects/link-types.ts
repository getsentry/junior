import {
  objectLinkFilterMatches,
  objectLinkFilterSpecificity,
  type ObjectAnnotation,
  type ObjectLinkFilter,
  type ObjectType,
  type User,
} from "@sentry/junior-plugin-api";

/** One link type of core or a plugin, with the viewer-scoped resolver. */
export interface ObjectLinkType {
  /**
   * False when the resolver reads a cache that its writes clear, so a
   * change shows at once instead of after the card cache expires.
   */
  cacheCards?: false;
  filters: readonly ObjectLinkFilter[];
  objectType: ObjectType;
  /** `junior` for core, or the plugin name. */
  owner: string;
  /** The tool that reads the object live, for a Turn after an attach. */
  readTool?: string;
  resolve(viewer: User, url: URL): Promise<ObjectAnnotation | undefined>;
}

function compareSpecificity(left: number[], right: number[]): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

// Two filters of equal specificity can claim the same URL only when they
// have the same scheme and host, and their paths can match one path.
function filtersOverlap(
  left: ObjectLinkFilter,
  right: ObjectLinkFilter,
): boolean {
  if ((left.scheme ?? "https") !== (right.scheme ?? "https")) return false;
  if (left.host !== right.host) return false;
  if (left.pathPattern !== undefined && right.pathPattern !== undefined) {
    const leftParts = left.pathPattern.split("/");
    const rightParts = right.pathPattern.split("/");
    return (
      leftParts.length === rightParts.length &&
      leftParts.every(
        (part, index) =>
          part === "*" ||
          rightParts[index] === "*" ||
          part === rightParts[index],
      )
    );
  }
  return (
    left.path === right.path &&
    left.pathPrefix === right.pathPrefix &&
    left.pathPattern === right.pathPattern
  );
}

/**
 * Throw when two link types can claim one URL with equal specificity, so
 * that the most specific match is always one link type.
 */
export function assertNoObjectLinkConflicts(
  linkTypes: readonly ObjectLinkType[],
): void {
  const filters = linkTypes.flatMap((linkType) =>
    linkType.filters.map((filter) => ({ filter, linkType })),
  );
  for (const [index, left] of filters.entries()) {
    for (const right of filters.slice(index + 1)) {
      if (
        left.linkType !== right.linkType &&
        compareSpecificity(
          objectLinkFilterSpecificity(left.filter),
          objectLinkFilterSpecificity(right.filter),
        ) === 0 &&
        filtersOverlap(left.filter, right.filter)
      ) {
        throw new Error(
          `Link types "${left.linkType.owner}/${left.linkType.objectType}" and "${right.linkType.owner}/${right.linkType.objectType}" claim the same URLs with equal filters.`,
        );
      }
    }
  }
}

/** Return the link type whose most specific filter claims the URL. */
export function findObjectLinkType(
  linkTypes: readonly ObjectLinkType[],
  url: URL,
): ObjectLinkType | undefined {
  let best: { linkType: ObjectLinkType; specificity: number[] } | undefined;
  for (const linkType of linkTypes) {
    for (const filter of linkType.filters) {
      if (!objectLinkFilterMatches(filter, url)) continue;
      const specificity = objectLinkFilterSpecificity(filter);
      if (!best || compareSpecificity(specificity, best.specificity) > 0) {
        best = { linkType, specificity };
      }
    }
  }
  return best?.linkType;
}
