import type { PiMessage } from "@/chat/pi/messages";

interface AwaitingSlackTurnStateArgs {
  activeSessionId: string;
  replied?: boolean;
  userMessageId?: string;
  userText?: string;
}

/** Build Slack conversation state with an active turn for resume-path tests. */
export function createAwaitingSlackTurnState(args: AwaitingSlackTurnStateArgs) {
  return {
    conversation: {
      schemaVersion: 1,
      backfill: {
        completedAtMs: 1,
        source: "recent_messages",
      },
      compactions: [],
      piMessages: [],
      messages: [
        {
          id: args.userMessageId ?? "msg-original",
          role: "user",
          text: args.userText ?? "please keep working",
          createdAtMs: 1,
          author: {
            userId: "U-test",
          },
          ...(args.replied === undefined
            ? {}
            : { meta: { replied: args.replied } }),
        },
      ],
      processing: {
        activeTurnId: args.activeSessionId,
      },
      stats: {
        compactedMessageCount: 0,
        estimatedContextTokens: 0,
        totalMessageCount: 1,
        updatedAtMs: 1,
      },
      vision: {
        byFileId: {},
      },
    },
  };
}

/** Build minimal Pi history for a user-authored turn session record. */
export function createPiUserTurn(text: string): PiMessage[] {
  return [
    {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: 1,
    },
  ];
}
