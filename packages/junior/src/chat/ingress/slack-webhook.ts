import { SlackAdapter, type SlackAdapterConfig } from "@chat-adapter/slack";
import type { ChatInstance, Message, WebhookOptions } from "chat";
import { buildMessageChangedMentionDispatch } from "@/chat/ingress/message-changed";

interface SlackRequestContext {
  botUserId?: string;
  token: string;
}

interface SlackEventPayload {
  event?:
    | {
        channel?: string;
      }
    | {
        item?: {
          channel?: string;
        };
      };
  is_ext_shared_channel?: boolean;
  team_id?: string;
  type?: string;
}

interface SlackAdapterInternals {
  _externalChannels: Set<string>;
  chat: ChatInstance | null;
  defaultBotToken?: string;
  logger: {
    warn(message: string, data?: Record<string, unknown>): void;
  };
  requestContext: {
    run<T>(store: SlackRequestContext, callback: () => T): T;
  };
  resolveTokenForTeam(teamId: string): Promise<SlackRequestContext | null>;
  verifySignature(
    body: string,
    timestamp: string | null,
    signature: string | null,
  ): boolean;
}

function getEventChannel(payload: SlackEventPayload): string | undefined {
  const event = payload.event;
  if (!event || typeof event !== "object") {
    return undefined;
  }
  if ("channel" in event && typeof event.channel === "string") {
    return event.channel;
  }
  if (
    "item" in event &&
    event.item &&
    typeof event.item === "object" &&
    "channel" in event.item &&
    typeof event.item.channel === "string"
  ) {
    return event.item.channel;
  }
  return undefined;
}

function assignMessageId(message: Message, id: string): void {
  (message as unknown as { id: string }).id = id;
}

class JuniorSlackAdapter extends SlackAdapter {
  /**
   * Preserve Slack verification and team scoping before handling edited mentions.
   */
  override async handleWebhook(
    request: Request,
    options?: WebhookOptions,
  ): Promise<Response> {
    const internal = this as unknown as SlackAdapterInternals;
    const body = await request.text();
    const replayRequest = () =>
      new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body,
      });

    const timestamp = request.headers.get("x-slack-request-timestamp");
    const signature = request.headers.get("x-slack-signature");
    if (!internal.verifySignature(body, timestamp, signature)) {
      return new Response("Invalid signature", { status: 401 });
    }

    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("application/x-www-form-urlencoded")) {
      return super.handleWebhook(replayRequest(), options);
    }

    let payload: SlackEventPayload;
    try {
      payload = JSON.parse(body) as SlackEventPayload;
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    if (!this.isMessageChangedPayload(payload)) {
      return super.handleWebhook(replayRequest(), options);
    }

    const processPayload = (): Response => {
      this.processVerifiedMessageChangedPayload(payload, options);
      return new Response("ok", { status: 200 });
    };

    if (!internal.defaultBotToken) {
      const teamId = payload.team_id;
      if (teamId) {
        const ctx = await internal.resolveTokenForTeam(teamId);
        if (ctx) {
          return internal.requestContext.run(ctx, processPayload);
        }
        internal.logger.warn("Could not resolve token for team", { teamId });
        return new Response("ok", { status: 200 });
      }
    }

    return processPayload();
  }

  private isMessageChangedPayload(payload: SlackEventPayload): boolean {
    return (
      payload.type === "event_callback" &&
      Boolean(payload.event) &&
      (payload.event as { type?: unknown }).type === "message" &&
      (payload.event as { subtype?: unknown }).subtype === "message_changed"
    );
  }

  private processVerifiedMessageChangedPayload(
    payload: SlackEventPayload,
    options?: WebhookOptions,
  ): void {
    const internal = this as unknown as SlackAdapterInternals;

    if (payload.is_ext_shared_channel) {
      const channelId = getEventChannel(payload);
      if (channelId) {
        internal._externalChannels.add(channelId);
      }
    }

    const dispatch = buildMessageChangedMentionDispatch(
      payload,
      this.botUserId,
    );
    if (dispatch && internal.chat) {
      const message = this.parseMessage(dispatch.event);
      assignMessageId(message, dispatch.messageId);
      message.isMention = true;
      internal.chat.processMessage(this, dispatch.threadId, message, options);
    }
  }
}

/**
 * Create the Slack adapter with Junior's verified edited-message routing.
 */
export function createJuniorSlackAdapter(
  config?: SlackAdapterConfig,
): SlackAdapter {
  return new JuniorSlackAdapter(config);
}
