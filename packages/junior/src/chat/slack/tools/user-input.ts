import { postSlackMessage } from "@/chat/slack/outbound";
import type { SlackToolContext } from "@/chat/slack/tool-support/context";
import { buildSlackUserInputMessage } from "@/chat/slack/user-input";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { createOperationKey } from "@/chat/tools/idempotency";
import type { ShowUserInputRequest } from "@/chat/tools/runtime/request-user-input";
import type { ToolState } from "@/chat/tools/types";

/**
 * Show user input requests as a button message in the active Slack thread.
 * A click comes back as Slack input from the person who clicked.
 */
export function createSlackUserInputShow(
  context: SlackToolContext,
  state: ToolState,
): ShowUserInputRequest {
  return async (request) => {
    const channelId = context.locationChannelId;
    const threadTs = context.threadTs ?? context.messageTs;
    if (!threadTs) {
      throw new ToolInputError(
        "No active Slack thread is available for the question.",
      );
    }

    const operationKey = createOperationKey("requestUserInput", {
      channel_id: channelId,
      request,
      thread_ts: threadTs,
    });
    const cached = state.getOperationResult<{
      channel_id: string;
      message_ts: string;
    }>(operationKey);
    if (cached) {
      return { ...cached, deduplicated: true };
    }

    const message = buildSlackUserInputMessage(request);
    const posted = await postSlackMessage({
      blocks: message.blocks,
      channelId,
      text: message.text,
      threadTs,
    });
    const response = { channel_id: channelId, message_ts: posted.ts };
    state.setOperationResult(operationKey, response);
    return response;
  };
}
