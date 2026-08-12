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
  idempotencyKey: string;
  text: string;
};

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
  const message = draft.text;
  const id = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
    if (!text || props.pending) return;
    try {
      await props.onSubmit(text, draft.idempotencyKey);
      clearStoredDraft(storageKey);
      setDraft(emptyDraft());
    } catch {
      // The parent renders the mutation error. The stored draft keeps the same
      // idempotency key so a retry after reload cannot duplicate the message.
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
      {props.error || props.pending ? (
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
          disabled={props.pending}
          id={id}
          maxLength={32_000}
          onChange={(event) =>
            setDraft({
              idempotencyKey: crypto.randomUUID(),
              text: event.target.value,
            })
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
            aria-label={props.pending ? "Sending message" : props.submitLabel}
            disabled={!message.trim() || props.pending}
            title={props.pending ? "Sending message" : props.submitLabel}
            type="submit"
          >
            <Send aria-hidden="true" size={14} />
            <span className="hidden md:inline">
              {props.pending ? "Sending…" : props.submitLabel}
            </span>
          </Button>
        </div>
      </form>
    </div>
  );
}

function emptyDraft(): ConversationDraft {
  return { idempotencyKey: crypto.randomUUID(), text: "" };
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
      return {
        idempotencyKey: draft.idempotencyKey,
        text: draft.text.slice(0, 32_000),
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
