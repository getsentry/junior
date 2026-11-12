import { ThumbsDown, ThumbsUp } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";

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

// Good waits this long before it sends, so a mistaken click can be undone.
const GOOD_SEND_DELAY_MS = 5000;

type ReplyRatingState = {
  rating?: ReplyRating;
  sent: boolean;
  timer?: ReturnType<typeof setTimeout>;
  // Sends a pending Good now.
  sendGood?: () => void;
};

type ReplyRatings = {
  states: Map<string, ReplyRatingState>;
  listeners: Set<() => void>;
};

const UNRATED: ReplyRatingState = { sent: false };

/**
 * Reply ratings for the rows of one transcript list. Rows far from the
 * viewport unmount, so a pending or sent rating must outlive them.
 */
export const TranscriptReplyRatings = createContext<ReplyRatings | null>(null);

/**
 * Hold the Reply ratings of one transcript list. A pending Good sends at once
 * when the reader leaves the page or the list.
 */
export function useTranscriptReplyRatings() {
  const [ratings] = useState<ReplyRatings>(() => ({
    listeners: new Set(),
    states: new Map(),
  }));
  useEffect(() => {
    const flush = () => {
      for (const state of ratings.states.values()) state.sendGood?.();
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [ratings]);
  return ratings;
}

/**
 * Rate one Junior Reply with thumbs up or down. Good sends after a short
 * delay, so the reader can clear it or switch to Bad first. Bad asks for an
 * optional comment and sends on Send. Each Reply sends at most one Sentry
 * feedback while its transcript list stays mounted.
 */
export function ReplyRatingActions(props: {
  conversationId: string;
  messageId: string;
}) {
  const reader = useDashboardCoreData().data?.me.user;
  const ratings = useContext(TranscriptReplyRatings);
  if (!ratings) throw new Error("Reply ratings need TranscriptReplyRatings");
  const read = () => ratings.states.get(props.messageId) ?? UNRATED;
  const { rating, sent } = useSyncExternalStore(
    useCallback(
      (listener: () => void) => {
        ratings.listeners.add(listener);
        return () => ratings.listeners.delete(listener);
      },
      [ratings],
    ),
    read,
    read,
  );
  const [commentOpen, setCommentOpen] = useState(false);
  const [comment, setComment] = useState("");

  if (!canSendReplyRating()) return null;

  // Handlers read the store, not the render values, so a fast second submit
  // sees `sent`, and a Good timer still works after its row unmounts.
  const write = (state: ReplyRatingState) => {
    ratings.states.set(props.messageId, state);
    for (const listener of ratings.listeners) listener();
  };
  const send = (next: ReplyRating, text?: string) => {
    if (read().sent) return;
    write({ rating: next, sent: true });
    sendReplyRating({ ...props, comment: text, rating: next, reader });
  };
  const cancelGood = () => {
    clearTimeout(read().timer);
    write(UNRATED);
  };
  const toggleGood = () => {
    const current = read();
    if (current.sent) return;
    if (current.rating === "good") {
      cancelGood();
      return;
    }
    const sendGood = () => {
      clearTimeout(read().timer);
      send("good");
    };
    write({
      rating: "good",
      sendGood,
      sent: false,
      timer: setTimeout(sendGood, GOOD_SEND_DELAY_MS),
    });
  };
  const sendBad = () => {
    setCommentOpen(false);
    send("bad", comment.trim() || undefined);
  };

  return (
    <>
      {!sent || rating === "good" ? (
        <MessageAction
          aria-pressed={rating === "good"}
          label="Good reply"
          onClick={toggleGood}
        >
          <ThumbsUp
            aria-hidden="true"
            fill={rating === "good" ? "currentColor" : "none"}
            size={15}
          />
        </MessageAction>
      ) : null}
      {!sent || rating === "bad" ? (
        <Popover
          // A rated Reply keeps this button, so focus returns to it after
          // Send, but it opens nothing. Opening it drops a pending Good.
          onOpenChange={(open) => {
            if (open && read().sent) return;
            if (open && read().rating === "good") cancelGood();
            setCommentOpen(open);
          }}
          open={commentOpen}
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <PopoverTrigger
                  render={
                    <Button
                      variant="ghost"
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
                variant="default"
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
