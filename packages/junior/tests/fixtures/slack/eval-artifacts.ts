import { getCapturedSlackApiCalls } from "../../msw/handlers/slack-api";

export interface EvalSlackApiCall {
  method: string;
  params: Record<string, unknown>;
}

export interface EvalSlackCanvasArtifact {
  markdown: string;
  title: string;
}

export interface EvalSlackChannelPost {
  channel: string;
  text: string;
  thread_ts?: string;
}

export interface EvalSlackReaction {
  channel: string;
  emoji: string;
  timestamp: string;
}

export interface EvalSlackArtifacts {
  canvases: EvalSlackCanvasArtifact[];
  channelPosts: EvalSlackChannelPost[];
  reactions: EvalSlackReaction[];
}

function toFirstString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const resolved = toFirstString(entry);
      if (resolved) return resolved;
    }
  }
  return undefined;
}

function buildReactionKey(input: {
  channel: string;
  emoji: string;
  timestamp: string;
}): string {
  return `${input.channel}:${input.timestamp}:${input.emoji}`;
}

export function collectEvalSlackArtifactsFromSlackApiCalls(
  calls: EvalSlackApiCall[],
): EvalSlackArtifacts {
  const canvases: EvalSlackCanvasArtifact[] = [];
  const channelPosts: EvalSlackChannelPost[] = [];
  const reactions = new Map<string, EvalSlackReaction>();

  for (const call of calls) {
    if (call.method === "canvases.create") {
      const title = toFirstString(call.params.title) ?? "";
      const documentContent =
        call.params.document_content &&
        typeof call.params.document_content === "object"
          ? (call.params.document_content as Record<string, unknown>)
          : undefined;
      const markdown = documentContent
        ? (toFirstString(documentContent.markdown) ?? "")
        : "";
      if (!title && markdown.length === 0) {
        continue;
      }
      canvases.push({ title, markdown });
      continue;
    }

    if (call.method === "chat.postMessage") {
      const channel = toFirstString(call.params.channel);
      const text = toFirstString(call.params.text);
      if (!channel || text === undefined) {
        continue;
      }
      const threadTs = toFirstString(call.params.thread_ts);
      channelPosts.push({
        channel,
        text,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      continue;
    }

    if (call.method === "reactions.add") {
      const channel = toFirstString(call.params.channel);
      const emoji = toFirstString(call.params.name);
      const timestamp = toFirstString(call.params.timestamp);
      if (!channel || !emoji || !timestamp) {
        continue;
      }
      const reaction = { channel, emoji, timestamp };
      reactions.set(buildReactionKey(reaction), reaction);
      continue;
    }

    if (call.method === "reactions.remove") {
      const channel = toFirstString(call.params.channel);
      const emoji = toFirstString(call.params.name);
      const timestamp = toFirstString(call.params.timestamp);
      if (!channel || !emoji || !timestamp) {
        continue;
      }
      reactions.delete(buildReactionKey({ channel, emoji, timestamp }));
    }
  }

  return {
    canvases,
    channelPosts,
    reactions: [...reactions.values()],
  };
}

/** Return Slack-visible artifacts captured by the eval-local Slack HTTP harness. */
export function collectEvalSlackArtifacts(): EvalSlackArtifacts {
  return collectEvalSlackArtifactsFromSlackApiCalls(getCapturedSlackApiCalls());
}

/** Find the latest auth state URL sent through eval-visible Slack messages. */
export function findLatestOAuthStateFromEvalSlackArtifacts(args: {
  authorizeEndpoint: string;
  consumedStates: Set<string>;
}): string | undefined {
  const expectedUrl = new URL(args.authorizeEndpoint);
  const calls = getCapturedSlackApiCalls();

  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    if (
      call.method !== "chat.postEphemeral" &&
      call.method !== "chat.postMessage"
    ) {
      continue;
    }
    const text = toFirstString(call.params.text);
    if (!text) {
      continue;
    }
    const match = text.match(/<([^|>]+)\|/);
    if (!match?.[1]) {
      continue;
    }

    let authLink: URL;
    try {
      authLink = new URL(match[1]);
    } catch {
      continue;
    }

    if (
      authLink.origin !== expectedUrl.origin ||
      authLink.pathname !== expectedUrl.pathname
    ) {
      continue;
    }
    const state = authLink.searchParams.get("state")?.trim();
    if (state && !args.consumedStates.has(state)) {
      return state;
    }
  }

  return undefined;
}
