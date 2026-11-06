import { ThumbsDown, ThumbsUp } from "lucide-react";
import { useState } from "react";

import { MessageAction } from "../components/ui/message";
import {
  canSendReplyRating,
  sendReplyRating,
  type ReplyRating,
} from "../sentry";

/**
 * Rate one Junior Reply with thumbs up or down. The rating goes to Sentry and
 * is not stored, so it shows only until the row unmounts.
 */
export function ReplyRatingActions(props: {
  conversationId: string;
  messageId: string;
}) {
  const [rating, setRating] = useState<ReplyRating>();
  if (!canSendReplyRating()) return null;

  const rate = (next: ReplyRating) => {
    if (next === rating) return;
    setRating(next);
    sendReplyRating({ ...props, rating: next });
  };
  return (
    <>
      <MessageAction
        aria-pressed={rating === "good"}
        label="Good reply"
        onClick={() => rate("good")}
      >
        <ThumbsUp
          aria-hidden="true"
          fill={rating === "good" ? "currentColor" : "none"}
          size={15}
        />
      </MessageAction>
      <MessageAction
        aria-pressed={rating === "bad"}
        label="Bad reply"
        onClick={() => rate("bad")}
      >
        <ThumbsDown
          aria-hidden="true"
          fill={rating === "bad" ? "currentColor" : "none"}
          size={15}
        />
      </MessageAction>
    </>
  );
}
