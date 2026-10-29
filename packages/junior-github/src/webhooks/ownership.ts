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

// Quotes and code repeat other text, so a mention there does not address the
// bot. HTML is not shown as text.
const SKIPPED_TOKEN_TYPES = new Set(["blockquote", "code", "codespan", "html"]);

/**
 * Collect the text of Markdown tokens outside quotes, code, and HTML. Join
 * inline tokens with no separator, so `me@bot` stays one word.
 */
function ownTokenText(tokens: readonly Token[], separator = ""): string {
  return tokens
    .map((token): string => {
      if (SKIPPED_TOKEN_TYPES.has(token.type)) return " ";
      // `Token` includes a generic token, so `type` does not narrow it.
      if (token.type === "list") {
        return (token as Tokens.List).items
          .map((item) => ownTokenText(item.tokens, "\n"))
          .join("\n");
      }
      if (token.type === "table") {
        const table = token as Tokens.Table;
        return [table.header, ...table.rows]
          .flat()
          .map((cell) => ownTokenText(cell.tokens))
          .join(" ");
      }
      if ("tokens" in token && token.tokens) return ownTokenText(token.tokens);
      return "text" in token ? token.text : token.raw;
    })
    .join(separator);
}

/**
 * Keep the author's own text. A GitHub-flavored Markdown parser finds the
 * quotes and code, the same as GitHub when it renders the comment.
 */
function ownCommentText(text: string): string {
  return ownTokenText(lexer(text, { gfm: true }), "\n");
}

// HTML quote tags. Their content is a quote, like a Markdown quote.
const HTML_QUOTE_OPEN = /<\s*blockquote\b/gi;
const HTML_QUOTE_CLOSE = /<\s*\/\s*blockquote\s*>/gi;

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

function hasQuoteOrHtml(token: Token): boolean {
  return (
    token.type === "blockquote" ||
    token.type === "html" ||
    childTokens(token).some(hasQuoteOrHtml)
  );
}

/** Count the HTML quote tags in a token, and how many stay open after it. */
function htmlQuoteTags(token: Token): { count: number; open: number } {
  if (token.type === "html") {
    const opens = token.raw.match(HTML_QUOTE_OPEN)?.length ?? 0;
    const closes = token.raw.match(HTML_QUOTE_CLOSE)?.length ?? 0;
    return { count: opens + closes, open: opens - closes };
  }
  return childTokens(token)
    .map(htmlQuoteTags)
    .reduce(
      (sum, tags) => ({
        count: sum.count + tags.count,
        open: sum.open + tags.open,
      }),
      { count: 0, open: 0 },
    );
}

/**
 * Collect the source of Markdown tokens outside quotes and HTML, at any
 * depth. A block with an HTML quote tag is left out as a whole. Blocks after
 * it are left out until the quote closes, because Markdown splits an HTML
 * quote at blank lines.
 */
function unquotedTokenText(tokens: readonly Token[], separator = ""): string {
  let openQuotes = 0;
  return tokens
    .map((token): string => {
      const tags = htmlQuoteTags(token);
      if (openQuotes > 0 || tags.count > 0) {
        openQuotes = Math.max(0, openQuotes + tags.open);
        return "\n";
      }
      if (token.type === "blockquote" || token.type === "html") return "\n";
      if (!hasQuoteOrHtml(token)) return token.raw;
      if (token.type === "list") {
        return (token as Tokens.List).items
          .map((item) => unquotedTokenText(item.tokens, "\n").trim())
          .filter(Boolean)
          .map((item) => `- ${item}`)
          .join("\n");
      }
      if (token.type === "table") {
        const table = token as Tokens.Table;
        return [table.header, ...table.rows]
          .map((row) =>
            row.map((cell) => unquotedTokenText(cell.tokens)).join(" | "),
          )
          .join("\n");
      }
      return unquotedTokenText(childTokens(token));
    })
    .join(separator);
}

/**
 * Return the comment text without Markdown or HTML quotes, or undefined when
 * nothing is left. A quote repeats text that someone else wrote, so it is
 * never the author's own words. This also removes quotes in lists and tables.
 * Code stays, because an instruction can name a command.
 */
export function unquotedCommentText(
  text: string | null | undefined,
): string | undefined {
  if (!text) return undefined;
  return (
    unquotedTokenText(lexer(text, { gfm: true }))
      // Removed quotes leave blank lines.
      .replace(/\n{3,}/g, "\n\n")
      .trim() || undefined
  );
}

/**
 * Check whether the author's own text mentions the bot encoded in the
 * configured bot email. GitHub sends mentions only as comment text, with no
 * structured field, so this reads the App slug: the bot login without `[bot]`.
 * This shows only that the comment addresses the bot. It does not grant trust;
 * match the commenter's `senderId` for that.
 */
export function mentionsBotLogin(
  text: string,
  botEmail: string | undefined,
): boolean {
  const slug = botLoginFromEmail(botEmail)?.replace(/\[bot\]$/i, "");
  if (!slug) return false;
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\w-])@${escaped}(?![\\w-])`, "i").test(
    ownCommentText(text),
  );
}
