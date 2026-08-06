import { getSlackClient, withSlackRetries } from "@/chat/slack/client";
import { parseSlackTeamId, type SlackTeamId } from "@/chat/slack/ids";
import { parseSlackTeamDomain } from "@/chat/slack/source-link";

const TEAM_DOMAIN_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const TEAM_DOMAIN_NEGATIVE_CACHE_TTL_MS = 60 * 1000;

type TeamDomainCacheEntry =
  | { kind: "hit"; domain: string; expiresAt: number }
  | { kind: "miss"; expiresAt: number };

const teamDomainCache = new Map<string, TeamDomainCacheEntry>();
const teamDomainInflight = new Map<string, Promise<string | undefined>>();

function readTeamDomainCache(teamId: SlackTeamId): string | null | undefined {
  const hit = teamDomainCache.get(teamId);
  if (!hit) return undefined;
  if (hit.expiresAt < Date.now()) {
    teamDomainCache.delete(teamId);
    return undefined;
  }
  return hit.kind === "hit" ? hit.domain : null;
}

function writeTeamDomainCache(
  teamId: SlackTeamId,
  domain: string | undefined,
): void {
  if (domain) {
    teamDomainCache.set(teamId, {
      kind: "hit",
      domain,
      expiresAt: Date.now() + TEAM_DOMAIN_CACHE_TTL_MS,
    });
    return;
  }
  teamDomainCache.set(teamId, {
    kind: "miss",
    expiresAt: Date.now() + TEAM_DOMAIN_NEGATIVE_CACHE_TTL_MS,
  });
}

async function fetchSlackTeamDomain(
  teamId: SlackTeamId,
): Promise<string | undefined> {
  try {
    const response = await withSlackRetries(
      () => getSlackClient().team.info({ team: teamId }),
      3,
      {
        action: "team.info",
        idempotent: true,
        spanAttributes: {
          "app.slack.team_id": teamId,
        },
      },
    );
    const responseTeamId = parseSlackTeamId(response.team?.id);
    const domain = parseSlackTeamDomain(response.team?.domain);
    if (!domain || !responseTeamId || responseTeamId !== teamId) {
      writeTeamDomainCache(teamId, undefined);
      return undefined;
    }
    writeTeamDomainCache(teamId, domain);
    return domain;
  } catch {
    writeTeamDomainCache(teamId, undefined);
    return undefined;
  }
}

/** Resolve a workspace subdomain via `team.info`, cached by team id. */
export async function resolveSlackTeamDomain(
  teamId: string,
): Promise<string | undefined> {
  const parsedTeamId = parseSlackTeamId(teamId);
  if (!parsedTeamId) return undefined;

  const cached = readTeamDomainCache(parsedTeamId);
  if (cached !== undefined) {
    return cached ?? undefined;
  }

  const pending = teamDomainInflight.get(parsedTeamId);
  if (pending) return pending;

  const lookup = fetchSlackTeamDomain(parsedTeamId).finally(() => {
    teamDomainInflight.delete(parsedTeamId);
  });
  teamDomainInflight.set(parsedTeamId, lookup);
  return lookup;
}

/** Resolve workspace subdomains for the distinct team ids in one API response. */
export async function resolveSlackTeamDomains(
  teamIds: Iterable<string>,
): Promise<ReadonlyMap<string, string>> {
  const uniqueTeamIds = [
    ...new Set(
      [...teamIds]
        .map((teamId) => parseSlackTeamId(teamId))
        .filter((teamId): teamId is SlackTeamId => teamId !== undefined),
    ),
  ];
  const resolved = await Promise.all(
    uniqueTeamIds.map(async (teamId) => {
      const domain = await resolveSlackTeamDomain(teamId);
      return domain ? ([teamId, domain] as const) : undefined;
    }),
  );
  return new Map(
    resolved.filter(
      (entry): entry is readonly [SlackTeamId, string] => entry !== undefined,
    ),
  );
}
