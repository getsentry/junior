import type { PluginCache } from "@sentry/junior-plugin-api";
import * as z from "zod";

const GITHUB_STATUS_INCIDENTS_URL =
  "https://www.githubstatus.com/api/v2/incidents.json";

// During an outage, many failures arrive at once. One shared read per minute
// serves all of them, so Junior does not flood githubstatus.com.
const GITHUB_STATUS_TTL_MS = 60 * 1000;
// A failed check event waits for this read, so a slow status page must not
// hold it.
const GITHUB_STATUS_TIMEOUT_MS = 5000;

const incidentsResponseSchema = z.object({
  incidents: z.array(
    z.object({
      components: z.array(z.object({ name: z.string() })).default([]),
      created_at: z.string(),
      impact: z.string(),
      name: z.string(),
      resolved_at: z.string().nullable(),
      shortlink: z.string(),
      started_at: z.string().nullable().optional(),
      status: z.string(),
    }),
  ),
});

/** One incident from githubstatus.com. */
export type GitHubStatusIncident = {
  components: string[];
  impact: string;
  name: string;
  resolvedAt?: string;
  startedAt: string;
  status: string;
  url: string;
};

// githubstatus.com is public and takes no GitHub credential, so it does not
// go through GitHub egress.
async function fetchGitHubStatusIncidents(): Promise<GitHubStatusIncident[]> {
  const response = await fetch(GITHUB_STATUS_INCIDENTS_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(GITHUB_STATUS_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`githubstatus.com returned HTTP ${response.status}`);
  }
  const parsed = incidentsResponseSchema.parse(await response.json());
  return parsed.incidents.map((incident) => {
    const result: GitHubStatusIncident = {
      components: incident.components.map((component) => component.name),
      impact: incident.impact,
      name: incident.name,
      startedAt: incident.started_at ?? incident.created_at,
      status: incident.status,
      url: incident.shortlink,
    };
    if (incident.resolved_at) result.resolvedAt = incident.resolved_at;
    return result;
  });
}

/**
 * Read GitHub incidents that are open, or that were resolved within
 * `withinMs`. Callers share one cached read of githubstatus.com.
 */
export async function loadGitHubStatusIncidents(
  cache: PluginCache,
  withinMs: number,
): Promise<GitHubStatusIncident[]> {
  const incidents = await cache.getOrLoad(
    "githubstatus:incidents",
    async () => ({
      ttlMs: GITHUB_STATUS_TTL_MS,
      value: await fetchGitHubStatusIncidents(),
    }),
  );
  const since = Date.now() - withinMs;
  return incidents.filter(
    (incident) =>
      !incident.resolvedAt || Date.parse(incident.resolvedAt) >= since,
  );
}
