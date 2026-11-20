/**
 * Link cards for one Sentry release.
 *
 * The viewer's own Sentry account reads the release, so Sentry decides who
 * may see it: it refuses a viewer who can see none of the release's
 * projects. The card lists the projects as Sentry returns them to that
 * viewer. The result is cached per viewer and release for a minute:
 * `canView` reads the release, and `resolve` draws the card from the same
 * entry. Junior's org read token only finds the org's region host.
 */
import { createHash } from "node:crypto";
import type {
  ObjectAnnotation,
  ObjectLinkContext,
  PluginObjectLinkDefinition,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { sentryApi, sentryData } from "./api.js";
import { sentryRegionOrigin } from "./region.js";
import {
  parseSentryReleaseLink,
  SENTRY_RELEASE_LINK_FILTERS,
  type SentryReleaseLink,
} from "./release-urls.js";

// The same time as the card cache.
const RELEASE_CACHE_TTL_MS = 60_000;
// Sentry refuses a release that the token may not read, or a bad version.
const REFUSED = [400, 401, 403, 404];

/** What a release card shows, read with the viewer's own token. */
interface SentryRelease {
  version: string;
  shortVersion: string;
  projects: string[];
  newIssues: number;
  crashFreeSessions?: number | undefined;
  deployCount: number;
  lastDeploy?:
    | { environment: string; finishedAt?: string | undefined }
    | undefined;
  releasedAt?: string | undefined;
}

const releaseSchema = z.object({
  version: z.string(),
  shortVersion: z.string().nullish(),
  newGroups: z.number().int().nonnegative().nullish(),
  deployCount: z.number().int().nonnegative().nullish(),
  dateCreated: z.string().nullish(),
  dateReleased: z.string().nullish(),
  lastDeploy: z
    .object({ environment: z.string(), dateFinished: z.string().nullish() })
    .nullish(),
  projects: z.array(
    z.object({
      slug: z.string(),
      healthData: z
        .object({
          crashFreeSessions: z.number().nullish(),
          totalSessions: z.number().nullish(),
        })
        .nullish(),
    }),
  ),
});

function isoTime(value: string | null | undefined): string | undefined {
  const time = value ? Date.parse(value) : NaN;
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

// Sentry gives each project its own crash-free rate. Weigh them by session
// count, which gives the rate of all the release's sessions.
function crashFreeSessions(
  projects: z.infer<typeof releaseSchema>["projects"],
): number | undefined {
  let sessions = 0;
  let crashFree = 0;
  for (const { healthData } of projects) {
    const rate = healthData?.crashFreeSessions;
    const total = healthData?.totalSessions;
    if (rate == null || !total || total < 0) continue;
    sessions += total;
    crashFree += (rate / 100) * total;
  }
  if (sessions === 0) return undefined;
  return Math.min(100, Math.max(0, (crashFree / sessions) * 100));
}

/** Keep only the fields the card shows. */
function sentryRelease(data: z.infer<typeof releaseSchema>): SentryRelease {
  const version = data.version.slice(0, 160);
  return {
    version,
    shortVersion: data.shortVersion?.trim().slice(0, 160) || version,
    projects: data.projects.slice(0, 5).map(({ slug }) => slug.slice(0, 160)),
    newIssues: data.newGroups ?? 0,
    crashFreeSessions: crashFreeSessions(data.projects),
    deployCount: data.deployCount ?? 0,
    lastDeploy: data.lastDeploy?.environment.trim()
      ? {
          environment: data.lastDeploy.environment.trim().slice(0, 160),
          finishedAt: isoTime(data.lastDeploy.dateFinished),
        }
      : undefined,
    releasedAt: isoTime(data.dateReleased ?? data.dateCreated),
  };
}

function versionHash(version: string): string {
  return createHash("sha256").update(version).digest("hex").slice(0, 32);
}

/** Read the release with the viewer's token. Nothing when Sentry refuses. */
async function readRelease(
  ctx: ObjectLinkContext,
  origin: string,
  link: SentryReleaseLink,
): Promise<SentryRelease | null> {
  // Sentry reads `health=1`, not the `true` that the client would send.
  const query = new URLSearchParams({ health: "1" });
  if (link.project) query.set("project", link.project);
  const result = await sentryApi(
    ctx.viewerEgress,
    origin,
    "sentry.release.get",
  ).getOrganizationRelease({
    path: { organization_id_or_slug: link.org, version: link.version },
    // The client calls the serializer only when it has a query.
    query: { health: true },
    querySerializer: () => query.toString(),
  });
  const data = sentryData(result, REFUSED, "release read");
  const parsed = data === null ? undefined : releaseSchema.safeParse(data);
  return parsed?.success ? sentryRelease(parsed.data) : null;
}

/** Read the release for this viewer, cached per viewer and release. */
async function viewerRelease(
  ctx: ObjectLinkContext,
  url: URL,
): Promise<{ link: SentryReleaseLink; release: SentryRelease } | null> {
  const link = parseSentryReleaseLink(url);
  if (!link) return null;
  const release = await ctx.cache.getOrLoad(
    `release:${ctx.viewer.id}:${link.org}/${link.project ?? ""}:${link.version}`,
    async () => {
      const origin = await sentryRegionOrigin(ctx, link.org);
      const value = origin ? await readRelease(ctx, origin, link) : null;
      return { value, ttlMs: RELEASE_CACHE_TTL_MS };
    },
  );
  return release && { link, release };
}

async function canViewSentryReleaseLink(
  ctx: ObjectLinkContext,
  url: URL,
): Promise<boolean> {
  return (await viewerRelease(ctx, url)) !== null;
}

async function resolveSentryReleaseLink(
  ctx: ObjectLinkContext,
  url: URL,
): Promise<ObjectAnnotation | undefined> {
  const read = await viewerRelease(ctx, url);
  if (!read) return undefined;
  const { link, release } = read;
  return {
    kind: "object",
    objectType: "release",
    // A version can be 250 characters, longer than a key allows.
    key: `release:${link.org}/${link.project ?? ""}:${versionHash(link.version)}`,
    label: release.shortVersion,
    title: release.version,
    url: url.href.length <= 2048 ? url.href : null,
    displayType: "Sentry release",
    facts: {
      type: "release",
      version: release.version,
      projects: release.projects,
      newIssues: release.newIssues,
      crashFreeSessions: release.crashFreeSessions,
      deployCount: release.deployCount,
      lastDeploy: release.lastDeploy,
      releasedAt: release.releasedAt,
    },
  };
}

/** Sentry release links, on sentry.io and customer domains. */
export const sentryReleaseLinks: PluginObjectLinkDefinition = {
  canView: canViewSentryReleaseLink,
  filters: SENTRY_RELEASE_LINK_FILTERS,
  objectTypes: ["release"],
  resolve: resolveSentryReleaseLink,
};
