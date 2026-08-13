import {
  memo,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { Send } from "lucide-react";

import { Button } from "../components/Button";
import { useDashboardOnline } from "../connection";

const MOBILE_COMPOSER_MAX_HEIGHT_PX = 112;
const DESKTOP_MEDIA_QUERY = "(min-width: 768px)";
const DRAFT_STORAGE_PREFIX = "junior:dashboard:conversation-draft:";
// Keep keystrokes off the storage path. Mobile Safari pays for every write.
const DRAFT_STORAGE_DEBOUNCE_MS = 250;

type ConversationDraft = {
  /** Key issued for `lastSubmittedText`. Reused while the next send matches it. */
  idempotencyKey: string;
  /** Trimmed text the current idempotency key was issued for. */
  lastSubmittedText: string;
  text: string;
};

type ConversationAttempt = {
  idempotencyKey: string;
  lastSubmittedText: string;
};

/** Choose the send attempt for one submit. Same trimmed text reuses the key. */
export function conversationAttemptForSubmit(
  current: ConversationAttempt,
  text: string,
): ConversationAttempt {
  if (text === current.lastSubmittedText) return current;
  return {
    idempotencyKey: crypto.randomUUID(),
    lastSubmittedText: text,
  };
}

type ConversationComposerProps = {
  draftId: string;
  error?: string;
  label: string;
  /**
   * Restore the submitted text after a failed accept when there is no mailbox
   * outbox (new conversation create). Existing conversations keep failures in
   * the pending queue instead.
   */
  restoreDraftOnError?: boolean;
  submitLabel: string;
  onFocus?: () => void;
  onSubmit(message: string, idempotencyKey: string): Promise<void>;
  onSubmitStart?: () => void;
};

/** Render the dashboard message composer for a new or existing conversation. */
export const ConversationComposer = memo(function ConversationComposer(
  props: ConversationComposerProps,
) {
  const storageKey = `${DRAFT_STORAGE_PREFIX}${encodeURIComponent(props.draftId)}`;
  const [draft, setDraft] = useState<ConversationDraft>(() =>
    readStoredDraft(storageKey),
  );
  // New-conversation create holds the send control until accept settles so a
  // failed restore cannot race a later submit.
  const [createPending, setCreatePending] = useState(false);
  const online = useDashboardOnline();
  const message = draft.text;
  const id = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(draft);
  // Source of truth for the in-flight attempt. React state alone is too late for
  // a second Enter before the parent pending flag flips.
  const attemptRef = useRef<ConversationAttempt>({
    idempotencyKey: draft.idempotencyKey,
    lastSubmittedText: draft.lastSubmittedText,
  });
  // Blocks same-tick double fire. For create restore, also blocks until settle.
  const submittingRef = useRef(false);
  // Monotonic token so a late failed create never restores over a newer submit.
  const submitTokenRef = useRef(0);
  const sendLocked = props.restoreDraftOnError && createPending;
  draftRef.current = draft;

  // Persist drafts after typing settles so storage never contends with keystrokes.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      storeDraft(storageKey, draftRef.current);
    }, DRAFT_STORAGE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, storageKey]);

  // Flush the latest draft if the reader leaves before the debounce lands.
  useEffect(() => {
    return () => {
      storeDraft(storageKey, draftRef.current);
    };
  }, [storageKey]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const syncHeight = () => {
      if (window.matchMedia(DESKTOP_MEDIA_QUERY).matches) {
        if (textarea.style.height) textarea.style.height = "";
        return;
      }
      // Measure from auto height only when the value changed. Avoid layout work
      // on parent re-renders that leave the draft text alone.
      const previous = textarea.style.height;
      textarea.style.height = "auto";
      const nextHeight = Math.min(
        textarea.scrollHeight,
        MOBILE_COMPOSER_MAX_HEIGHT_PX,
      );
      const next = `${nextHeight}px`;
      if (previous === next) {
        textarea.style.height = previous;
        return;
      }
      textarea.style.height = next;
    };

    syncHeight();
    const media = window.matchMedia(DESKTOP_MEDIA_QUERY);
    media.addEventListener("change", syncHeight);
    return () => media.removeEventListener("change", syncHeight);
  }, [message]);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = message.trim();
    if (!text || !online || submittingRef.current || sendLocked) return;

    // Keep the key while the trimmed text matches the last attempt. Edits that
    // return to the same text (typo undo, IME) must not mint a new key or a
    // retry can duplicate a send the server already accepted.
    const attempt = conversationAttemptForSubmit(attemptRef.current, text);
    attemptRef.current = attempt;
    const submitToken = ++submitTokenRef.current;
    const submittedDraft: ConversationDraft = {
      ...attempt,
      text,
    };
    // Clear immediately so the reader can compose the next message. Existing
    // conversations keep failures in the mailbox outbox; new roots may restore.
    const nextAttempt = emptyDraft();
    const clearedDraft: ConversationDraft = {
      ...nextAttempt,
      text: "",
    };
    draftRef.current = clearedDraft;
    setDraft(clearedDraft);
    storeDraft(storageKey, clearedDraft);
    attemptRef.current = nextAttempt;
    submittingRef.current = true;
    if (props.restoreDraftOnError) setCreatePending(true);
    props.onSubmitStart?.();
    textareaRef.current?.focus({ preventScroll: true });
    // Existing conversations unlock immediately so the next message can queue.
    // Create restore stays locked until this accept settles.
    if (!props.restoreDraftOnError) {
      queueMicrotask(() => {
        submittingRef.current = false;
      });
    }

    try {
      await props.onSubmit(text, attempt.idempotencyKey);
    } catch {
      if (!props.restoreDraftOnError) {
        // Parent keeps the failed message in the mailbox queue for retry.
        return;
      }
      // Ignore stale failures after a newer submit owns the composer.
      if (submitToken !== submitTokenRef.current) return;
      // Restore only when the reader has not already started another draft.
      if (draftRef.current.text) return;
      draftRef.current = submittedDraft;
      attemptRef.current = attempt;
      setDraft(submittedDraft);
      storeDraft(storageKey, submittedDraft);
    } finally {
      if (props.restoreDraftOnError && submitToken === submitTokenRef.current) {
        submittingRef.current = false;
        setCreatePending(false);
      }
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div className="grid min-w-0 gap-1.5">
      {!online || props.error ? (
        <div
          aria-live="polite"
          className={
            !online
              ? "min-w-0 font-mono text-xs leading-relaxed text-amber-100/80"
              : "min-w-0 font-mono text-xs leading-relaxed text-red-300/80"
          }
        >
          {!online ? "Connect to send. Your draft is saved." : props.error}
        </div>
      ) : null}
      <form
        className="grid grid-cols-[minmax(0,1fr)_auto] items-end overflow-hidden rounded-lg border border-white/[0.09] bg-white/[0.035] focus-within:border-cyan-300/35 focus-within:ring-1 focus-within:ring-cyan-300/25 md:block"
        onSubmit={submit}
      >
        <label className="sr-only" htmlFor={id}>
          {props.label}
        </label>
        <textarea
          className="min-h-11 max-h-28 w-full resize-none overflow-y-auto border-0 bg-transparent px-3 py-2.5 font-mono text-sm leading-relaxed text-dashboard-text outline-none placeholder:text-dashboard-text-muted/65 md:min-h-24 md:max-h-none md:resize-y md:overflow-visible md:px-3.5 md:py-3"
          id={id}
          maxLength={32_000}
          onChange={(event) => {
            const text = event.target.value;
            setDraft((current) => {
              if (current.text === text) return current;
              const next = { ...current, text };
              draftRef.current = next;
              return next;
            });
          }}
          onFocus={props.onFocus}
          onKeyDown={handleKeyDown}
          placeholder="Message Junior…"
          ref={textareaRef}
          rows={1}
          value={message}
        />
        <div className="flex min-w-0 items-center justify-end gap-3 border-l border-white/[0.07] bg-black/15 px-2 py-1.5 md:justify-between md:border-l-0 md:border-t md:px-3 md:py-2">
          <div className="hidden min-w-0 font-mono text-xs leading-relaxed text-dashboard-text-muted md:block">
            Enter to send · Shift+Enter for a new line
          </div>
          <Button
            aria-label={sendLocked ? "Sending message" : props.submitLabel}
            disabled={!message.trim() || !online || sendLocked}
            title={
              !online
                ? "Connect to send"
                : sendLocked
                  ? "Sending message"
                  : props.submitLabel
            }
            type="submit"
          >
            <Send aria-hidden="true" size={14} />
            <span className="hidden md:inline">
              {sendLocked ? "Sending…" : props.submitLabel}
            </span>
          </Button>
        </div>
      </form>
    </div>
  );
});

function emptyDraft(): ConversationDraft {
  return {
    idempotencyKey: crypto.randomUUID(),
    lastSubmittedText: "",
    text: "",
  };
}

function readStoredDraft(storageKey: string): ConversationDraft {
  if (typeof window === "undefined") return emptyDraft();
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) return emptyDraft();
    const draft: unknown = JSON.parse(stored);
    if (
      typeof draft === "object" &&
      draft !== null &&
      "idempotencyKey" in draft &&
      typeof draft.idempotencyKey === "string" &&
      "text" in draft &&
      typeof draft.text === "string"
    ) {
      const text = draft.text.slice(0, 32_000);
      const lastSubmittedText =
        "lastSubmittedText" in draft &&
        typeof draft.lastSubmittedText === "string"
          ? draft.lastSubmittedText
          : // Older drafts only stored text + key. Bind the key to that text so
            // a retry after reload still reuses it.
            text.trim();
      return {
        idempotencyKey: draft.idempotencyKey,
        lastSubmittedText,
        text,
      };
    }
  } catch {
    // Storage can be unavailable in private browsing or contain stale data.
  }
  return emptyDraft();
}

function storeDraft(storageKey: string, draft: ConversationDraft): void {
  if (typeof window === "undefined") return;
  try {
    if (draft.text) {
      window.localStorage.setItem(storageKey, JSON.stringify(draft));
    } else {
      window.localStorage.removeItem(storageKey);
    }
  } catch {
    // Keep the in-memory composer usable when storage is unavailable.
  }
}
