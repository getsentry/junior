/**
 * The API host of a Sentry org's region.
 *
 * Sentry clients send an org's API calls to its region host, such as
 * `us.sentry.io` or `de.sentry.io`. The org details at `sentry.io` name it
 * in `links.regionUrl`.
 */
import type { ObjectLinkContext } from "@sentry/junior-plugin-api";
import * as z from "zod";
import { SENTRY_API_DOMAINS } from "../org-read.js";
import { sentryApi, sentryData } from "./api.js";

const SENTRY_ORIGIN = "https://sentry.io";
// An org stays in its region, so one lookup a day is enough.
const REGION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// A refused lookup can change soon, such as after a new org read token.
const REFUSED_CACHE_TTL_MS = 60_000;

const orgSchema = z.object({
  links: z.object({ regionUrl: z.string() }).partial().nullish(),
});

// Junior sends Sentry credentials only to these hosts.
function regionOrigin(org: string, regionUrl: string): string {
  const url = URL.canParse(regionUrl) ? new URL(regionUrl) : undefined;
  if (
    url?.protocol !== "https:" ||
    url.port !== "" ||
    url.pathname !== "/" ||
    !SENTRY_API_DOMAINS.includes(url.hostname)
  ) {
    throw new Error(
      `Sentry org "${org}" names a region URL that Junior does not call`,
    );
  }
  return url.origin;
}

async function readRegionOrigin(
  ctx: ObjectLinkContext,
  org: string,
): Promise<string | null> {
  const result = await sentryApi(
    ctx.egress,
    SENTRY_ORIGIN,
    "sentry.organization.get",
  ).getOrganization({ path: { organization_id_or_slug: org } });
  // A token for another org gets 403. An unknown org is 404.
  const data = sentryData(result, [401, 403, 404], "org read");
  if (data === null) return null;
  const regionUrl = orgSchema.parse(data).links?.regionUrl;
  return regionUrl ? regionOrigin(org, regionUrl) : SENTRY_ORIGIN;
}

/**
 * Return the API origin of the org's region, cached per org for a day.
 * Nothing when Junior cannot read the org, cached for one minute. Throws
 * when the org names a region host that is not a Sentry API host.
 */
export async function sentryRegionOrigin(
  ctx: ObjectLinkContext,
  org: string,
): Promise<string | null> {
  return ctx.cache.getOrLoad(`region:${org}`, async () => {
    const origin = await readRegionOrigin(ctx, org);
    return {
      value: origin,
      ttlMs: origin ? REGION_CACHE_TTL_MS : REFUSED_CACHE_TTL_MS,
    };
  });
}
