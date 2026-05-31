import { slackLocationLabel } from "../format";
import type { Conversation } from "../types";

/** Render compact conversation metadata aligned to row context. */
export function ConversationRowStats(props: {
  conversation: Conversation;
  timeLabel: string;
}) {
  return (
    <div className="grid min-w-0 justify-items-end gap-1 text-right max-md:justify-items-start max-md:text-left">
      <div className="text-[0.84rem] leading-relaxed text-[#b8b8b8]">
        {props.conversation.turns.length} turns · {props.timeLabel}
      </div>
      {props.conversation.channel ? (
        <div className="max-w-full break-words text-[0.84rem] leading-relaxed text-[#888] md:truncate">
          {slackLocationLabel(props.conversation, { includeId: false })}
        </div>
      ) : null}
    </div>
  );
}
