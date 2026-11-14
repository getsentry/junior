import { lexer, type Token, type Tokens } from "marked";

const GITHUB_BOT_NOREPLY_EMAIL =
  /^(?<userId>[1-9]\d*)\+(?<login>[^@]+\[bot\])@users\.noreply\.github\.com$/i;

interface GitHubBotIdentity {
  login: string;
  userId: number;
}

/** Parse the bot identity encoded in GitHub's standard noreply address. */
function parseGitHubBotIdentity(
  value: string | undefined,
): GitHubBotIdentity | undefined {
  const match = GITHUB_BOT_NOREPLY_EMAIL.exec(value?.trim() ?? "");
  const login = match?.groups?.login;
  const userId = match?.groups?.userId;
  if (!login || !userId) return undefined;
  return {
    login,
    userId: Number(userId),
  };
}

/** Derive the provider login encoded in a standard GitHub noreply address. */
export function botLoginFromEmail(
  value: string | undefined,
): string | undefined {
  return parseGitHubBotIdentity(value)?.login;
}

/** Check whether a GitHub login is the bot encoded in the configured bot email. */
export function isBotLogin(
  login: string | null | undefined,
  botEmail: string | undefined,
): boolean {
  const botLogin = botLoginFromEmail(botEmail)?.toLowerCase();
  return Boolean(botLogin && login?.trim().toLowerCase() === botLogin);
}

/** Derive the GitHub user id encoded in a standard GitHub noreply address. */
export function botUserIdFromEmail(
  value: string | undefined,
): number | undefined {
  return parseGitHubBotIdentity(value)?.userId;
}

// An HTML quote tag. Its content is a quote, like a Markdown quote.
const HTML_QUOTE_OPEN = /<\s*blockquote\b/i;

function childTokens(token: Token): readonly Token[] {
  // `Token` includes a generic token, so `type` does not narrow it.
  if (token.type === "list") {
    return (token as Tokens.List).items.flatMap((item) => item.tokens);
  }
  if (token.type === "table") {
    const table = token as Tokens.Table;
    return [table.header, ...table.rows].flat().flatMap((cell) => cell.tokens);
  }
  return "tokens" in token && token.tokens ? token.tokens : [];
}

function hasHtmlQuote(token: Token): boolean {
  return (
    (token.type === "html" && HTML_QUOTE_OPEN.test(token.raw)) ||
    childTokens(token).some(hasHtmlQuote)
  );
}

/**
 * Split a comment into the text that its author wrote (`own`) and the rest
 * (`other`), such as quotes. Each part is undefined when it is empty. This is
 * the one parser for a GitHub author's own text.
 *
 * A quote repeats text that someone else wrote, so it is never the author's
 * own words. Markdown quotes and HTML are removed, also in lists and tables.
 * An HTML quote has no reliable end: Markdown splits it at blank lines, and a
 * closing tag can hide in an HTML comment or attribute. So the block with the
 * first HTML quote tag and all text after it are removed. Each rule removes
 * text, so a parse that GitHub renders differently can only drop the
 * author's words, never add words that someone else wrote.
 *
 * Code stays, because an instruction can name a command. `withoutCode` also
 * removes code, where text in code does not count, such as a mention.
 *
 * The removed text goes to `other`, so it is shown once, as text that the
 * author did not write.
 */
export function splitCommentText(
  text: string | null | undefined,
  options: { withoutCode?: boolean } = {},
): { other?: string; own?: string } {
  if (!text) return {};
  const other: string[] = [];
  const removed = (token: Token): boolean =>
    token.type === "blockquote" ||
    token.type === "html" ||
    (options.withoutCode === true &&
      (token.type === "code" || token.type === "codespan"));
  const hasRemoved = (token: Token): boolean =>
    removed(token) || childTokens(token).some(hasRemoved);
  let afterHtmlQuote = false;
  const tokenText = (tokens: readonly Token[], separator = ""): string =>
    tokens
      .map((token): string => {
        if (afterHtmlQuote || hasHtmlQuote(token)) {
          afterHtmlQuote = true;
          other.push(token.raw);
          return "\n";
        }
        if (removed(token)) {
          other.push(token.raw);
          return token.type === "codespan" ? " " : "\n";
        }
        if (!hasRemoved(token)) return token.raw;
        if (token.type === "list") {
          return (token as Tokens.List).items
            .map((item) => tokenText(item.tokens, "\n").trim())
            .filter(Boolean)
            .map((item) => `- ${item}`)
            .join("\n");
        }
        if (token.type === "table") {
          const table = token as Tokens.Table;
          return [table.header, ...table.rows]
            .map((row) => row.map((cell) => tokenText(cell.tokens)).join(" | "))
            .join("\n");
        }
        return tokenText(childTokens(token));
      })
      .join(separator);
  const own = tokenText(lexer(text, { gfm: true }))
    // Removed quotes leave blank lines.
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const rest = other
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
  return {
    ...(own ? { own } : undefined),
    ...(rest ? { other: rest } : undefined),
  };
}

/**
 * Check whether the author's own text mentions the bot encoded in the
 * configured bot email. GitHub sends mentions only as comment text, with no
 * structured field, so this reads the App slug: the bot login without `[bot]`.
 * This shows only that the comment addresses the bot. It does not grant
 * trust; core decides that from the Event author.
 */
export function mentionsBotLogin(
  text: string,
  botEmail: string | undefined,
): boolean {
  const slug = botLoginFromEmail(botEmail)?.replace(/\[bot\]$/i, "");
  if (!slug) return false;
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\w-])@${escaped}(?![\\w-])`, "i").test(
    splitCommentText(text, { withoutCode: true }).own ?? "",
  );
}
