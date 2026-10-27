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
  if (!match?.groups) return undefined;
  return {
    login: match.groups.login,
    userId: Number(match.groups.userId),
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

/**
 * Keep the author's own text. Quoted lines and code repeat other text, so a
 * mention there does not address the bot.
 */
function ownCommentText(text: string): string {
  const kept: string[] = [];
  let fence: string | undefined;
  for (const line of text.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker?.startsWith(fence)) fence = undefined;
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    if (/^ {0,3}>/.test(line)) continue;
    kept.push(line.replace(/`[^`]*`/g, " "));
  }
  return kept.join("\n");
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
