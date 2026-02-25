interface MentionToken {
  id: string;
  label?: string;
}

const BOT_USER_ID_CACHE_TTL_MS = 60 * 60 * 1000;

let runtimeBotUserId: string | undefined;
let cachedResolvedBotUserId: { value: string | null; expiresAtMs: number } | null = null;
let inFlightBotUserIdLookup: Promise<string | undefined> | null = null;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeOptionalValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function parseMentionTokens(text: string): MentionToken[] {
  const mentions: MentionToken[] = [];
  const mentionRe = /<@([^>|]+)(?:\|([^>]+))?>/gi;

  for (const match of text.matchAll(mentionRe)) {
    const id = match[1]?.trim();
    if (!id) continue;
    const label = match[2]?.trim();
    mentions.push({ id, label: label || undefined });
  }

  return mentions;
}

export function stripLeadingBotMention(text: string, options: { userName: string; botUserId?: string }): string {
  if (!text.trim()) {
    return text;
  }

  const userName = normalizeOptionalValue(options.userName);
  const botUserId = normalizeOptionalValue(options.botUserId);
  let result = text;

  if (botUserId) {
    const leadingBotIdMentionRe = new RegExp(`^\\s*<@${escapeRegExp(botUserId)}(?:\\|[^>]+)?>[\\s,:-]*`, "i");
    result = result.replace(leadingBotIdMentionRe, "").trim();
  }

  if (userName) {
    const leadingNameMentionRe = new RegExp(`^\\s*@${escapeRegExp(userName)}\\b[\\s,:-]*`, "i");
    result = result.replace(leadingNameMentionRe, "").trim();

    const leadingLabeledMentionRe = new RegExp(
      `^\\s*<@[^>|]+\\|${escapeRegExp(userName)}>[\\s,:-]*`,
      "i"
    );
    result = result.replace(leadingLabeledMentionRe, "").trim();
  }

  return result;
}

export function messageExplicitlyMentionsBot(text: string, options: { userName: string; botUserId?: string }): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  const userName = normalizeOptionalValue(options.userName);
  if (userName) {
    const byName = new RegExp(`\\b@?${escapeRegExp(userName)}\\b`, "i").test(trimmed);
    if (byName) {
      return true;
    }
  }

  const mentions = parseMentionTokens(trimmed);
  if (mentions.length === 0) {
    return false;
  }

  const botUserId = normalizeOptionalValue(options.botUserId);
  if (botUserId) {
    const normalizedBotUserId = botUserId.toLowerCase();
    return mentions.some((mention) => mention.id.toLowerCase() === normalizedBotUserId);
  }

  if (!userName) {
    return false;
  }

  const normalizedUserName = userName.toLowerCase();
  return mentions.some((mention) => mention.label?.toLowerCase() === normalizedUserName);
}

export function registerKnownBotMention(text: string, userName: string): void {
  const mentions = parseMentionTokens(text);
  if (mentions.length === 0) {
    return;
  }

  const normalizedUserName = userName.trim().toLowerCase();
  const labeledMatch = mentions.find((mention) => mention.label?.trim().toLowerCase() === normalizedUserName);
  const candidateId = labeledMatch?.id ?? (mentions.length === 1 ? mentions[0]?.id : undefined);

  if (!candidateId) {
    return;
  }

  runtimeBotUserId = candidateId;
}

async function fetchBotUserIdFromSlack(): Promise<string | undefined> {
  const token = normalizeOptionalValue(process.env.SLACK_BOT_TOKEN);
  if (!token) {
    return undefined;
  }

  try {
    const response = await fetch("https://slack.com/api/auth.test", {
      headers: {
        authorization: `Bearer ${token}`
      }
    });

    if (!response.ok) {
      return undefined;
    }

    const payload = (await response.json()) as {
      ok?: boolean;
      user_id?: string;
    };

    if (!payload.ok) {
      return undefined;
    }

    return normalizeOptionalValue(payload.user_id);
  } catch {
    return undefined;
  }
}

export async function resolveSlackBotUserId(): Promise<string | undefined> {
  const configuredBotUserId = normalizeOptionalValue(process.env.SLACK_BOT_USER_ID);
  if (configuredBotUserId) {
    return configuredBotUserId;
  }

  if (runtimeBotUserId) {
    return runtimeBotUserId;
  }

  const nowMs = Date.now();
  if (cachedResolvedBotUserId && cachedResolvedBotUserId.expiresAtMs > nowMs) {
    return cachedResolvedBotUserId.value ?? undefined;
  }

  if (inFlightBotUserIdLookup) {
    return inFlightBotUserIdLookup;
  }

  inFlightBotUserIdLookup = (async () => {
    const resolvedBotUserId = await fetchBotUserIdFromSlack();
    cachedResolvedBotUserId = {
      value: resolvedBotUserId ?? null,
      expiresAtMs: Date.now() + BOT_USER_ID_CACHE_TTL_MS
    };
    if (resolvedBotUserId) {
      runtimeBotUserId = resolvedBotUserId;
    }
    return resolvedBotUserId;
  })();

  try {
    return await inFlightBotUserIdLookup;
  } finally {
    inFlightBotUserIdLookup = null;
  }
}

export function resetSlackMentionsStateForTest(): void {
  runtimeBotUserId = undefined;
  cachedResolvedBotUserId = null;
  inFlightBotUserIdLookup = null;
}
