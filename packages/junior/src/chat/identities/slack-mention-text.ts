import { and, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { parseMarkdown, walkAst } from "chat";
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

function mapStrings(
  value: unknown,
  replace: (text: string) => string,
): unknown {
  if (typeof value === "string") return replace(value);
  if (Array.isArray(value)) {
    return value.map((item) => mapStrings(item, replace));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        mapStrings(item, replace),
      ]),
    );
  }
  return value;
}

/** Return the Slack tokens in `text` outside Markdown code. */
function slackTokens(text: string): RegExpExecArray[] {
  const code: Array<[number, number]> = [];
  walkAst(parseMarkdown(text), (node) => {
    const { start, end } = node.position ?? {};
    if (
      (node.type === "code" || node.type === "inlineCode") &&
      start?.offset !== undefined &&
      end?.offset !== undefined
    ) {
      code.push([start.offset, end.offset]);
    }
    return node;
  });
  return [...text.matchAll(SLACK_TOKEN_PATTERN)].filter(
    ({ index }) => !code.some(([start, end]) => index >= start && index < end),
  );
}

function replaceToken(
  token: SlackToken,
  people: Map<string, { handle?: string; name?: string }>,
): string {
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
}

/**
 * Rewrite Slack syntax in every string of `value`, such as a tool input that
 * goes to another provider, because the provider shows it as literal text.
 * Markdown code stays as written. A Slack user becomes `@handle` of their
 * linked account at `provider`. Without one, they become their name, so the
 * text never mentions a guessed account. Channel and special mentions become
 * plain words, and `<url|label>` becomes a Markdown link.
 */
export async function replaceSlackMentions<T>(
  value: T,
  provider: string,
): Promise<T> {
  const tokens = new Map<string, RegExpExecArray[]>();
  mapStrings(value, (text) => {
    // Slack syntax always starts with `<`, so most strings need no parse.
    if (text.includes("<")) tokens.set(text, slackTokens(text));
    return text;
  });
  const matches = [...tokens.values()].flat();
  if (matches.length === 0) return value;
  const userIds = new Set(matches.flatMap((match) => match.groups?.user ?? []));
  const people = await readSlackPeople([...userIds], provider);
  return mapStrings(value, (text) => {
    let result = "";
    let cursor = 0;
    for (const match of tokens.get(text) ?? []) {
      result += text.slice(cursor, match.index);
      result += replaceToken(match.groups as SlackToken, people);
      cursor = match.index + match[0].length;
    }
    return result + text.slice(cursor);
  }) as T;
}
