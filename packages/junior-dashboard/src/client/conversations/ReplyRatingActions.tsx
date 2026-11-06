import { ThumbsDown, ThumbsUp } from "lucide-react";
import { useState } from "react";

import { useDashboardCoreData } from "../api";
import { Button } from "../components/ui/button";
import { MessageAction } from "../components/ui/message";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "../components/ui/popover";
import { Textarea } from "../components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import {
  canSendReplyRating,
  sendReplyRating,
  type ReplyRating,
} from "../sentry";

/**
 * Rate one Junior Reply with thumbs up or down. Bad asks for an optional
 * comment first. The first rating is final, so each Reply sends at most one
 * Sentry feedback. Ratings are not stored: a remount can rate again.
 */
export function ReplyRatingActions(props: {
  conversationId: string;
  messageId: string;
}) {
  const reader = useDashboardCoreData().data?.me.user;
  const [rating, setRating] = useState<ReplyRating>();
  const [commentOpen, setCommentOpen] = useState(false);
  const [comment, setComment] = useState("");
  if (!canSendReplyRating()) return null;

  const rate = (next: ReplyRating, text?: string) => {
    setRating(next);
    sendReplyRating({ ...props, comment: text, rating: next, reader });
  };
  const sendBad = () => {
    setCommentOpen(false);
    rate("bad", comment.trim() || undefined);
  };

  return (
    <>
      {rating !== "bad" ? (
        <MessageAction
          aria-pressed={rating === "good"}
          label="Good reply"
          onClick={() => {
            if (!rating) rate("good");
          }}
        >
          <ThumbsUp
            aria-hidden="true"
            fill={rating === "good" ? "currentColor" : "none"}
            size={15}
          />
        </MessageAction>
      ) : null}
      {rating !== "good" ? (
        <Popover
          // A rated Reply keeps this button, so focus returns to it after
          // Send, but it opens nothing.
          onOpenChange={(open) => setCommentOpen(open && !rating)}
          open={commentOpen}
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <PopoverTrigger
                  render={
                    <Button
                      aria-label="Bad reply"
                      aria-pressed={rating === "bad"}
                      data-slot="message-action"
                      size="icon"
                    />
                  }
                />
              }
            >
              <ThumbsDown
                aria-hidden="true"
                fill={rating === "bad" ? "currentColor" : "none"}
                size={15}
              />
            </TooltipTrigger>
            <TooltipContent size="compact">Bad reply</TooltipContent>
          </Tooltip>
          <PopoverContent align="start" className="grid w-72 gap-2 p-3">
            <PopoverTitle>What went wrong?</PopoverTitle>
            <form
              className="grid gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                sendBad();
              }}
            >
              <Textarea
                aria-label="Comment"
                className="min-h-20"
                onChange={(event) => setComment(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    (event.metaKey || event.ctrlKey)
                  ) {
                    event.preventDefault();
                    sendBad();
                  }
                }}
                placeholder="Optional"
                value={comment}
              />
              <Button
                className="justify-self-end"
                type="submit"
                variant="primary"
              >
                Send
              </Button>
            </form>
          </PopoverContent>
        </Popover>
      ) : null}
    </>
  );
}
