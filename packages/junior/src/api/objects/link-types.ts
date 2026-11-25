import {
  objectLinkFilterMatches,
  objectLinkFilterSpecificity,
  type ObjectAnnotation,
  type ObjectLinkFilter,
  type ObjectLinkPrefetchOutcome,
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
  /**
   * Whether the viewer may see the object. Called before `resolve`, with
   * the URL's prefetch outcome in a page read.
   */
  canView(
    viewer: User,
    url: URL,
    prefetched?: ObjectLinkPrefetchOutcome,
  ): Promise<boolean>;
  filters: readonly ObjectLinkFilter[];
  /** Name the object from its link, for a card that cannot read it. */
  label?(url: URL): string | undefined;
  /** The object types that `resolve` can return. */
  objectTypes: readonly ObjectType[];
  /** `junior` for core, or the plugin name. */
  owner: string;
  /**
   * Load the objects of many URLs in one call, before each is resolved.
   * Returns the outcome of each URL whose read must know it, by `href`.
   */
  prefetch?(
    viewer: User,
    urls: URL[],
  ): Promise<ReadonlyMap<string, ObjectLinkPrefetchOutcome> | void>;
  /** The tool that reads the object live, for a Turn after an attach. */
  readTool?(object: ObjectAnnotation): string | undefined;
  resolve(
    viewer: User,
    url: URL,
    prefetched?: ObjectLinkPrefetchOutcome,
  ): Promise<ObjectAnnotation | undefined>;
  /** Show the web page card when `canView` returns false. */
  webPageFallback?: true;
}

/** A link type name for errors, such as `github/task/code_change`. */
export function linkTypeName(linkType: ObjectLinkType): string {
  return `${linkType.owner}/${linkType.objectTypes.join("/")}`;
}

function compareSpecificity(left: number[], right: number[]): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

// Two filters of equal specificity can claim the same URL only when they
// have the same scheme and host, their paths can match one path, and their
// targets can match one target URL.
function filtersOverlap(
  left: ObjectLinkFilter,
  right: ObjectLinkFilter,
): boolean {
  if ((left.scheme ?? "https") !== (right.scheme ?? "https")) return false;
  if (left.host !== right.host) return false;
  if (!pathsOverlap(left, right)) return false;
  // A URL can carry two different parameters, so only targets on the same
  // parameter can rule out an overlap.
  if (left.target?.param !== right.target?.param) return true;
  const rightTargets = right.target?.filters ?? [];
  return (
    left.target === undefined ||
    left.target.filters.some((leftTarget) =>
      rightTargets.some((rightTarget) =>
        targetsOverlap(leftTarget, rightTarget),
      ),
    )
  );
}

// Target filters can differ in specificity, so a broader one, such as a
// wildcard host or no path, overlaps every narrower one that it claims.
function targetsOverlap(
  left: ObjectLinkFilter,
  right: ObjectLinkFilter,
): boolean {
  if ((left.scheme ?? "https") !== (right.scheme ?? "https")) return false;
  if (!hostsOverlap(left.host, right.host)) return false;
  if (left.path !== undefined) return pathClaims(right, left.path);
  if (right.path !== undefined) return pathClaims(left, right.path);
  if (left.pathPrefix !== undefined && right.pathPrefix !== undefined) {
    return (
      left.pathPrefix.startsWith(right.pathPrefix) ||
      right.pathPrefix.startsWith(left.pathPrefix)
    );
  }
  // Two patterns compare by segment. A missing path claims every path, and
  // a prefix and a pattern count as overlapping.
  return bothPatterns(left, right) ? pathsOverlap(left, right) : true;
}

function hostsOverlap(left?: string, right?: string): boolean {
  if (left === undefined || right === undefined) return true;
  return hostClaims(left, right) || hostClaims(right, left);
}

// `*.example.com` claims `a.example.com` and `*.a.example.com`.
function hostClaims(wide: string, narrow: string): boolean {
  return (
    wide === narrow || (wide.startsWith("*.") && narrow.endsWith(wide.slice(1)))
  );
}

function pathClaims(filter: ObjectLinkFilter, path: string): boolean {
  const { path: exact, pathPattern, pathPrefix } = filter;
  return objectLinkFilterMatches(
    { path: exact, pathPattern, pathPrefix },
    new URL(path, "https://link.invalid"),
  );
}

function bothPatterns(left: ObjectLinkFilter, right: ObjectLinkFilter) {
  return left.pathPattern !== undefined && right.pathPattern !== undefined;
}

function pathsOverlap(left: ObjectLinkFilter, right: ObjectLinkFilter) {
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
          `Link types "${linkTypeName(left.linkType)}" and "${linkTypeName(right.linkType)}" claim the same URLs with equal filters.`,
        );
      }
    }
  }
}

/** Return the link type whose most specific filter claims the URL. */
export function findObjectLinkType<
  T extends { filters: readonly ObjectLinkFilter[] },
>(linkTypes: readonly T[], url: URL): T | undefined {
  let best: { linkType: T; specificity: number[] } | undefined;
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
