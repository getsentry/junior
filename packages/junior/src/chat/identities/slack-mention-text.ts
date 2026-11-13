import { and, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getSqlExecutor } from "@/chat/db";
import { juniorIdentities, juniorUsers } from "@/db/schema";

// Slack-only syntax: user, channel, and special mentions, and labeled links.
// Special mentions start with a letter, so `<!-- comments -->` stay.
const SLACK_TOKEN_PATTERN = new RegExp(
  [
    String.raw`<@(?<user>[UW][A-Z0-9]+)(?:\|(?<userLabel>[^<>]*))?>`,
    String.raw`<#(?<channel>[CG][A-Z0-9]+)(?:\|(?<channelLabel>[^<>]*))?>`,
    String.raw`<!(?<special>[a-z]+(?:\^[^<>|\s]*)?)(?:\|(?<specialLabel>[^<>]*))?>`,
    String.raw`<(?<url>(?:https?|mailto):[^<>|\s]+)\|(?<urlLabel>[^<>]*)>`,
  ].join("|"),
  "g",
);

type SlackToken = Partial<
  Record<
    | "channel"
    | "channelLabel"
    | "special"
    | "specialLabel"
    | "url"
    | "urlLabel"
    | "user"
    | "userLabel",
    string
  >
>;

function plainLabel(label: string | undefined): string | undefined {
  return label?.trim().replace(/^[@#]/, "") || undefined;
}

const slackIdentity = alias(juniorIdentities, "slack_mention_identity");

/**
 * Read a name and the `provider` account handle of the people behind Slack
 * user IDs. A person with several accounts at `provider` gets the first
 * handle in sort order, so the result is stable.
 */
async function readSlackPeople(
  slackUserIds: string[],
  provider: string,
): Promise<Map<string, { handle?: string; name?: string }>> {
  if (slackUserIds.length === 0) return new Map();
  const rows = await getSqlExecutor()
    .db()
    .select({
      handle: juniorIdentities.handle,
      slackHandle: slackIdentity.handle,
      slackName: slackIdentity.displayName,
      slackUserId: slackIdentity.providerSubjectId,
      userName: juniorUsers.displayName,
    })
    .from(slackIdentity)
    .leftJoin(juniorUsers, eq(juniorUsers.id, slackIdentity.userId))
    .leftJoin(
      juniorIdentities,
      and(
        eq(juniorIdentities.userId, slackIdentity.userId),
        eq(juniorIdentities.kind, "user"),
        eq(juniorIdentities.provider, provider),
      ),
    )
    .where(
      and(
        eq(slackIdentity.kind, "user"),
        eq(slackIdentity.provider, "slack"),
        inArray(slackIdentity.providerSubjectId, slackUserIds),
      ),
    );
  const people = new Map<string, { handle?: string; name?: string }>();
  for (const row of rows) {
    const current = people.get(row.slackUserId) ?? {};
    const handle =
      row.handle && (!current.handle || row.handle < current.handle)
        ? row.handle
        : current.handle;
    const name =
      current.name ??
      (row.userName?.trim() ||
        row.slackName?.trim() ||
        row.slackHandle?.trim());
    people.set(row.slackUserId, {
      ...(handle ? { handle } : undefined),
      ...(name ? { name } : undefined),
    });
  }
  return people;
}

/**
 * Rewrite Slack syntax in text that goes to another provider, because the
 * provider shows it as literal text. A Slack user becomes `@handle` of their
 * linked account at `provider`. Without one, they become their name, so the
 * text never mentions a guessed account. Channel and special mentions become
 * plain words, and `<url|label>` becomes a Markdown link.
 */
export async function replaceSlackMentions(
  text: string,
  provider: string,
): Promise<string> {
  const matches = [...text.matchAll(SLACK_TOKEN_PATTERN)];
  if (matches.length === 0) return text;
  const userIds = [
    ...new Set(matches.flatMap((match) => match.groups?.user ?? [])),
  ];
  const people = await readSlackPeople(userIds, provider);
  return text.replace(SLACK_TOKEN_PATTERN, (...args) => {
    const token = args.at(-1) as SlackToken;
    if (token.url) {
      return token.urlLabel ? `[${token.urlLabel}](${token.url})` : token.url;
    }
    if (token.user) {
      const person = people.get(token.user);
      if (person?.handle) return `@${person.handle}`;
      return person?.name ?? plainLabel(token.userLabel) ?? "a Slack user";
    }
    if (token.channel) {
      const name = plainLabel(token.channelLabel);
      return name ? `#${name}` : "a Slack channel";
    }
    // `<!here>`, `<!subteam^S123|@team>`, and `<!date^…|fallback>`.
    return plainLabel(token.specialLabel) ?? token.special!.split("^")[0]!;
  });
}
