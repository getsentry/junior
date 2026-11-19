import { transcriptScrollClassName } from "./ChatLayout";
import { TranscriptMessageView } from "./TranscriptMessageView";
import { TranscriptRow, TranscriptRows } from "./TranscriptRows";
import type { ConversationOutlineItem } from "./conversationOutlineItems";
import type { ConversationTranscript } from "../types";
import { cn } from "../styles";

/**
 * Show an outline item over the transcript, where its message lands after
 * a jump, while the transcript loads and mounts the message's rows. It draws
 * the item like its transcript rows, so the swap to the real rows does not
 * move the message. It holds only what the outline knows: the message text
 * and the start of the reply. It takes the pointer, so no input reaches the
 * hidden rows below it, and a wheel or touch on it dismisses it.
 */
export function OutlineStandIn(props: {
  conversation: ConversationTranscript;
  item: ConversationOutlineItem;
  onDismiss(): void;
  /** Room above the message, like the jump leaves. */
  topPx: number;
}) {
  const { item } = props;
  return (
    <div
      aria-hidden="true"
      className={cn(
        // The padding of the scroll region lines the column up with it.
        transcriptScrollClassName,
        "absolute inset-0 z-10 overflow-hidden bg-background",
      )}
      data-outline-stand-in={item.seq}
      onTouchStart={props.onDismiss}
      onWheel={props.onDismiss}
    >
      <div
        className="mx-auto w-full max-w-[52.5rem]"
        inert
        style={{ paddingTop: props.topPx }}
      >
        <TranscriptRows>
          <TranscriptRow>
            <TranscriptMessageView
              conversation={props.conversation}
              message={{
                ...item.author,
                parts: [{ text: item.title, type: "text" }],
                role: "user",
                sourceSeq: item.seq,
                ...(item.timestamp === undefined
                  ? undefined
                  : { timestamp: item.timestamp }),
              }}
            />
          </TranscriptRow>
          {item.reply ? (
            <TranscriptRow>
              <TranscriptMessageView
                conversation={props.conversation}
                // The outline holds no time for the reply, which follows
                // the message.
                message={{
                  parts: [{ text: item.reply, type: "text" }],
                  role: "assistant",
                  sourceSeq: item.seq,
                  ...(item.timestamp === undefined
                    ? undefined
                    : { timestamp: item.timestamp }),
                }}
              />
            </TranscriptRow>
          ) : null}
        </TranscriptRows>
      </div>
    </div>
  );
}
