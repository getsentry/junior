import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { Send } from "lucide-react";

import { Button } from "../components/Button";

const MOBILE_COMPOSER_MAX_HEIGHT_PX = 112;
const DESKTOP_MEDIA_QUERY = "(min-width: 768px)";
const DRAFT_STORAGE_PREFIX = "junior:dashboard:conversation-draft:";

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

/** Render the dashboard message composer for a new or existing conversation. */
export function ConversationComposer(props: {
  draftId: string;
  error?: string;
  label: string;
  pending: boolean;
  submitLabel: string;
  onSubmit(message: string, idempotencyKey: string): Promise<void>;
}) {
  const storageKey = `${DRAFT_STORAGE_PREFIX}${encodeURIComponent(props.draftId)}`;
  const [draft, setDraft] = useState<ConversationDraft>(() =>
    readStoredDraft(storageKey),
  );
  const [submitting, setSubmitting] = useState(false);
  const message = draft.text;
  const id = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Source of truth for the in-flight attempt. React state alone is too late for
  // a second Enter before the parent pending flag flips.
  const attemptRef = useRef<ConversationAttempt>({
    idempotencyKey: draft.idempotencyKey,
    lastSubmittedText: draft.lastSubmittedText,
  });
  const submittingRef = useRef(false);
  const busy = props.pending || submitting;

  useEffect(() => {
    storeDraft(storageKey, draft);
  }, [draft, storageKey]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const syncHeight = () => {
      if (window.matchMedia(DESKTOP_MEDIA_QUERY).matches) {
        textarea.style.height = "";
        return;
      }
      textarea.style.height = "0px";
      const nextHeight = Math.min(
        textarea.scrollHeight,
        MOBILE_COMPOSER_MAX_HEIGHT_PX,
      );
      textarea.style.height = `${nextHeight}px`;
    };

    syncHeight();
    const media = window.matchMedia(DESKTOP_MEDIA_QUERY);
    media.addEventListener("change", syncHeight);
    return () => media.removeEventListener("change", syncHeight);
  }, [message]);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = message.trim();
    if (!text || busy || submittingRef.current) return;

    // Keep the key while the trimmed text matches the last attempt. Edits that
    // return to the same text (typo undo, IME) must not mint a new key or a
    // retry can duplicate a send the server already accepted.
    const attempt = conversationAttemptForSubmit(attemptRef.current, text);
    attemptRef.current = attempt;
    const nextDraft: ConversationDraft = {
      ...attempt,
      text: draft.text,
    };
    // Write storage before the request so a reload mid-send retries the same key.
    setDraft(nextDraft);
    storeDraft(storageKey, nextDraft);
    submittingRef.current = true;
    setSubmitting(true);

    try {
      await props.onSubmit(text, attempt.idempotencyKey);
      clearStoredDraft(storageKey);
      const cleared = emptyDraft();
      attemptRef.current = {
        idempotencyKey: cleared.idempotencyKey,
        lastSubmittedText: cleared.lastSubmittedText,
      };
      setDraft(cleared);
    } catch {
      // The parent renders the mutation error. The stored draft keeps the same
      // idempotency key so a retry after reload cannot duplicate the message.
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
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
      {props.error || busy ? (
        <div
          aria-live="polite"
          className={
            props.error
              ? "min-w-0 font-mono text-xs leading-relaxed text-red-300/80"
              : "min-w-0 font-mono text-xs leading-relaxed text-dashboard-text-muted"
          }
        >
          {props.error ?? "Sending message…"}
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
          className="min-h-11 max-h-28 w-full resize-none overflow-y-auto border-0 bg-transparent px-3 py-2.5 font-mono text-sm leading-relaxed text-dashboard-text outline-none placeholder:text-dashboard-text-muted/65 disabled:opacity-60 md:min-h-24 md:max-h-none md:resize-y md:overflow-visible md:px-3.5 md:py-3"
          disabled={busy}
          id={id}
          maxLength={32_000}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              text: event.target.value,
            }))
          }
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
            aria-label={busy ? "Sending message" : props.submitLabel}
            disabled={!message.trim() || busy}
            title={busy ? "Sending message" : props.submitLabel}
            type="submit"
          >
            <Send aria-hidden="true" size={14} />
            <span className="hidden md:inline">
              {busy ? "Sending…" : props.submitLabel}
            </span>
          </Button>
        </div>
      </form>
    </div>
  );
}

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

function clearStoredDraft(storageKey: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    // The successful send still clears the in-memory draft below.
  }
}
