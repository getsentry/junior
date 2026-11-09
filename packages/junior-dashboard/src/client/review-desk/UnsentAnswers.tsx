import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ReviewItemPayload } from "@sentry/junior/api/schema";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";

type UnsentAnswers = {
  conversationId: string;
  /** Item title for each mounted answer form that has unsent answers. */
  titles: Map<string, string>;
};

const UnsentAnswersContext = createContext<UnsentAnswers | undefined>(
  undefined,
);

/**
 * Track the answer forms in one Conversation that have unsent answers. A
 * message in the Conversation closes some open action items, and the
 * answers on those forms are then lost. The reply footer reads this to ask
 * first.
 */
export function UnsentAnswersProvider(props: {
  children: ReactNode;
  conversationId: string;
}) {
  const value = useMemo(
    () => ({ conversationId: props.conversationId, titles: new Map() }),
    [props.conversationId],
  );
  return (
    <UnsentAnswersContext.Provider value={value}>
      {props.children}
    </UnsentAnswersContext.Provider>
  );
}

/**
 * Report that the answer form of an item has unsent answers. It counts only
 * when a message from the viewer closes the item. This follows
 * `closeReviewItemsAnsweredByReply`: an open action item that the agent
 * added in this Conversation, not assigned to Everyone, that the viewer can
 * act on. Outside a Conversation it does nothing.
 */
export function useReportUnsentAnswer(
  item: ReviewItemPayload,
  unsent: boolean,
) {
  const context = useContext(UnsentAnswersContext);
  const key = useId();
  const closesOnReply =
    item.kind === "action" &&
    item.status === "open" &&
    item.canAct &&
    !item.assignedToEveryone &&
    item.addedByConversationId === context?.conversationId;
  const title = item.title;
  useEffect(() => {
    if (!context || !closesOnReply || !unsent) return;
    context.titles.set(key, title);
    return () => {
      context.titles.delete(key);
    };
  }, [closesOnReply, context, key, title, unsent]);
}

/**
 * Ask the reader before a message drops unsent answers. `confirmSubmit`
 * returns undefined when nothing would be lost, so the send goes at once.
 * Otherwise it opens `dialog` and resolves true when the reader sends anyway.
 */
export function useConfirmUnsentAnswers() {
  const context = useContext(UnsentAnswersContext);
  const [open, setOpen] = useState(false);
  // Keep the titles through the close animation.
  const [titles, setTitles] = useState<string[]>([]);
  const resolveRef = useRef<(send: boolean) => void>(undefined);

  const confirmSubmit = useCallback(() => {
    // The docked question and the side panel can show the same item.
    const unsent = [...new Set(context?.titles.values())];
    if (unsent.length === 0) return undefined;
    setTitles(unsent);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
    });
  }, [context]);

  // Resolve on close, so a dismissal by Escape also keeps the draft.
  const close = (send: boolean) => {
    resolveRef.current?.(send);
    resolveRef.current = undefined;
    setOpen(false);
  };

  const dialog = (
    <AlertDialog
      onOpenChange={(open) => {
        if (!open) close(false);
      }}
      open={open}
    >
      <AlertDialogContent>
        <AlertDialogTitle>Send without your answers?</AlertDialogTitle>
        <AlertDialogDescription>
          {titles.length === 1 ? (
            <>
              Your answers to{" "}
              <strong className="font-medium text-dashboard-text">
                {titles[0]}
              </strong>{" "}
              are not sent. This message closes that review item, and the
              answers are lost.
            </>
          ) : (
            `Your answers to ${titles.length} review items are not sent. This message closes those items, and the answers are lost.`
          )}
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel>Go back</AlertDialogCancel>
          <AlertDialogAction onClick={() => close(true)} variant="danger">
            Send message
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { confirmSubmit, dialog };
}
