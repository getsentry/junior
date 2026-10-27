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
