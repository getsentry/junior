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
