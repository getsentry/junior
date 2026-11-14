/**
 * Link types: URLs that a plugin or core can show as object cards.
 *
 * A link type declares static filters, like an Android `<intent-filter>`.
 * Junior matches a URL against the filters without plugin code, and then
 * calls the `resolve` of the most specific match for the viewer.
 */
import * as z from "zod";
import type { PluginContext, User } from "./context";
import type { ObjectAnnotation } from "./object-annotations";
import type { ObjectType } from "./object-presentation";
import type { PluginEgress, PluginViewerMcp } from "./tools";

const hostSchema = z
  .string()
  .regex(
    /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*(:\d+)?$/,
    "Use a lowercase host, or `*.` and a lowercase domain.",
  );
const pathSchema = z.string().max(500).startsWith("/");
// Each `*` is one whole path segment, such as `/conversations/*`.
const pathPatternSchema = pathSchema.regex(
  /^(\/([^/*]+|\*))+$/,
  "Use `/` segments. A `*` segment matches one segment.",
);

/** Which URLs a link type claims. Give at most one path field. */
export const objectLinkFilterSchema = z
  .strictObject({
    /** Defaults to `https`. */
    scheme: z.enum(["https", "http", "mailto"]).optional(),
    /** An exact host, or `*.example.com` for its subdomains. */
    host: hostSchema.optional(),
    path: pathSchema.optional(),
    pathPattern: pathPatternSchema.optional(),
    pathPrefix: pathSchema.optional(),
  })
  .refine(
    (filter) =>
      [filter.path, filter.pathPattern, filter.pathPrefix].filter(
        (value) => value !== undefined,
      ).length <= 1,
    "Give at most one of path, pathPattern, and pathPrefix.",
  )
  .refine(
    (filter) =>
      filter.scheme === "mailto"
        ? filter.host === undefined && !hasPathFilter(filter)
        : filter.host !== undefined,
    "An http or https filter needs a host. A mailto filter has no host or path.",
  );
export type ObjectLinkFilter = z.output<typeof objectLinkFilterSchema>;

function hasPathFilter(filter: {
  path?: string;
  pathPattern?: string;
  pathPrefix?: string;
}): boolean {
  return (
    filter.path !== undefined ||
    filter.pathPattern !== undefined ||
    filter.pathPrefix !== undefined
  );
}

function normalizedPath(url: URL): string {
  const path = url.pathname;
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** Return whether a filter claims a URL. A trailing slash does not count. */
export function objectLinkFilterMatches(
  filter: ObjectLinkFilter,
  url: URL,
): boolean {
  if (url.protocol !== `${filter.scheme ?? "https"}:`) return false;
  if (filter.host !== undefined) {
    const host = url.host.toLowerCase();
    const matches = filter.host.startsWith("*.")
      ? host.endsWith(filter.host.slice(1))
      : host === filter.host;
    if (!matches) return false;
  }
  const path = normalizedPath(url);
  if (filter.path !== undefined) return path === filter.path;
  if (filter.pathPrefix !== undefined) {
    return path.startsWith(filter.pathPrefix);
  }
  if (filter.pathPattern !== undefined) {
    const pattern = filter.pathPattern.split("/");
    const segments = path.split("/");
    return (
      pattern.length === segments.length &&
      pattern.every((part, index) =>
        part === "*" ? segments[index] !== "" : part === segments[index],
      )
    );
  }
  return true;
}

/**
 * Rank how specific a filter is. Compare ranks in order: an exact host
 * before a wildcard host, an exact path before a pattern before a prefix,
 * and then the longer match.
 */
export function objectLinkFilterSpecificity(
  filter: ObjectLinkFilter,
): number[] {
  const host = filter.host ?? "";
  const hostRank = !filter.host ? 0 : host.startsWith("*.") ? 1 : 2;
  if (filter.path !== undefined) {
    return [hostRank, host.length, 3, filter.path.length];
  }
  if (filter.pathPattern !== undefined) {
    const literals = filter.pathPattern
      .split("/")
      .filter((part) => part && part !== "*");
    return [hostRank, host.length, 2, literals.length];
  }
  if (filter.pathPrefix !== undefined) {
    return [hostRank, host.length, 1, filter.pathPrefix.length];
  }
  return [hostRank, host.length, 0, 0];
}

/** Trusted host context for one link resolution. */
export interface ObjectLinkContext extends PluginContext {
  /**
   * Provider egress as a system Actor. It gets only credentials that the
   * plugin owns, such as an app or Junior's own account, and never the
   * viewer's credentials. Check that the viewer may see the object before
   * you return it.
   */
  egress: PluginEgress;
  /**
   * Return the Junior path of one image that this plugin serves through
   * `images`, such as a file thumbnail. Put the path in facts, never the
   * address of the image. The image route asks `images.resolve` again for
   * each viewer. `version` changes the path when the image changes.
   */
  imagePath(ref: string, version?: string): string;
  /**
   * Return the Junior person card of the one known person with this
   * provider account, or undefined. Return it for a profile link of that
   * account, so the card shows the person and not only the account.
   */
  findPerson(account: {
    handle: string;
    provider: string;
  }): Promise<ObjectAnnotation | undefined>;
  /** The signed-in person who sees the card. */
  viewer: User;
  /**
   * Provider egress with only the viewer's own stored OAuth token for this
   * plugin's provider, such as a token from the dashboard Connections page.
   * It never asks the viewer to authorize, and it never uses a plugin
   * grant, an app token, or another person's token. A viewer without a
   * usable token gets HTTP 401. Use it to check that the viewer may see an
   * object, and read the card data with `egress`.
   */
  viewerEgress: PluginEgress;
  /**
   * This plugin's hosted MCP provider as the viewer, with only the viewer's
   * own stored login. Use it when the provider decides access only through
   * MCP.
   */
  viewerMcp: PluginViewerMcp;
}

/**
 * One link type of a plugin. Junior calls `canView` first, and calls
 * `resolve` only when it returns true. Junior does not save the result.
 */
export interface PluginObjectLinkDefinition {
  /**
   * Return whether `ctx.viewer` may see the object. Junior calls it before
   * each card read and again on each Attach. Return true for a public
   * object. Return false when you cannot tell, so the card does not show
   * that the object exists.
   */
  canView(ctx: ObjectLinkContext, url: URL): Promise<boolean>;
  filters: ObjectLinkFilter[];
  objectType: ObjectType;
  /**
   * Read the card. Junior calls it only after `canView` returns true.
   * Return nothing for a missing object.
   */
  resolve(
    ctx: ObjectLinkContext,
    url: URL,
  ): Promise<ObjectAnnotation | undefined>;
  /**
   * When `canView` returns false, show the public web page card of the
   * link, as for a link that no link type claims. Use it for a provider
   * whose public pages have useful web page metadata. That card reads only
   * what anyone can read without signing in.
   */
  webPageFallback?: true;
  /**
   * Name the plugin tool that reads the resolved object live, such as
   * `readGoogleFile`. When a person attaches the link to a Conversation, its
   * next Turn is told to read the object with this tool. Return nothing when
   * no tool reads this object.
   */
  readTool?(object: ObjectAnnotation): string | undefined;
}
