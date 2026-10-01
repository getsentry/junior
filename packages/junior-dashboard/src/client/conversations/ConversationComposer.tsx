import { INPUT_IMAGE_TYPES, type InputImage } from "@sentry/junior/api/schema";
import { ComposerImages, readComposerImages } from "./ComposerImages";
import {
  memo,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ImagePlus, Send } from "lucide-react";

import { Button } from "../components/Button";
import { useDashboardOnline } from "../connection";
import { cn, dashboardComposerSurfaceClass } from "../styles";

const MOBILE_COMPOSER_MAX_HEIGHT_PX = 112;
const DESKTOP_MEDIA_QUERY = "(min-width: 768px)";
const DRAFT_STORAGE_PREFIX = "junior:dashboard:conversation-draft:";
// Keep keystrokes off the storage path. Mobile Safari pays for every write.
const DRAFT_STORAGE_DEBOUNCE_MS = 250;

type ConversationDraft = {
  /** Image bytes are not restored from localStorage; do not reuse their send key. */
  hasImages?: boolean;
  /** Key issued for `lastSubmittedText`. Reused while the next send matches it. */
  idempotencyKey: string;
  /** Trimmed text the current idempotency key was issued for. */
  lastSubmittedText: string;
  text: string;
};

type ConversationAttempt = {
  images?: InputImage[];
  idempotencyKey: string;
  lastSubmittedText: string;
};

/** Reuse a send key only while its text and image selection stay unchanged. */
export function conversationAttemptForSubmit(
  current: ConversationAttempt,
  text: string,
  images?: InputImage[],
): ConversationAttempt {
  if (text === current.lastSubmittedText && images === current.images)
    return current;
  return {
    idempotencyKey: crypto.randomUUID(),
    lastSubmittedText: text,
    images,
  };
}

type ConversationComposerProps = {
  disabled?: boolean;
  draftId: string;
  error?: string;
  /**
   * Optional chrome to the left of the send row (create-mode visibility,
   * tools, etc). Presence also forces a stacked form so accessories are not
   * crushed beside the mobile send button.
   */
  footerStart?: ReactNode;
  label: string;
  /**
   * Restore the submitted text after a failed accept when there is no mailbox
   * outbox (new conversation create). Existing conversations keep failures in
   * the pending queue instead.
   */
  restoreDraftOnError?: boolean;
  submitLabel: string;
  onFocus?: () => void;
  onSubmit(
    message: string,
    idempotencyKey: string,
    images?: InputImage[],
  ): Promise<void>;
  onSubmitStart?: () => void;
};

/** Render the dashboard message composer for a new or existing conversation. */
export const ConversationComposer = memo(function ConversationComposer(
  props: ConversationComposerProps,
) {
  const storageKey = `${DRAFT_STORAGE_PREFIX}${encodeURIComponent(props.draftId)}`;
  const [initialDraft] = useState<ConversationDraft>(() =>
    readStoredDraft(storageKey),
  );
  // New-conversation create holds the send control until accept settles so a
  // failed restore cannot race a later submit.
  const [createPending, setCreatePending] = useState(false);
  const [canSend, setCanSend] = useState(() =>
    Boolean(initialDraft.text.trim()),
  );
  const [images, setImages] = useState<InputImage[]>([]);
  const imagesRef = useRef(images);
  const [imageError, setImageError] = useState<string>();
  const [readingImages, setReadingImages] = useState(false);
  const readingImagesRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const online = useDashboardOnline();
  const id = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(initialDraft);
  const canSendRef = useRef(canSend);
  const storageTimerRef = useRef<number | undefined>(undefined);
  // Source of truth for the in-flight attempt. React state alone is too late for
  // a second Enter before the parent pending flag flips.
  const attemptRef = useRef<ConversationAttempt>({
    idempotencyKey: initialDraft.idempotencyKey,
    lastSubmittedText: initialDraft.lastSubmittedText,
  });
  // Blocks same-tick double fire. For create restore, also blocks until settle.
  const submittingRef = useRef(false);
  // Monotonic token so a late failed create never restores over a newer submit.
  const submitTokenRef = useRef(0);
  const sendLocked =
    Boolean(props.disabled) || (props.restoreDraftOnError && createPending);

  // Flush the latest draft if the reader leaves before the debounce lands.
  useEffect(() => {
    return () => {
      if (storageTimerRef.current !== undefined) {
        window.clearTimeout(storageTimerRef.current);
      }
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
  }, []);

  const updateCanSend = (text: string) => {
    const nextCanSend = Boolean(text.trim());
    if (canSendRef.current === nextCanSend) return;
    canSendRef.current = nextCanSend;
    setCanSend(nextCanSend);
  };

  const replaceImages = (next: InputImage[]) => {
    imagesRef.current = next;
    setImages(next);
  };
  const addImages = async (files: File[]) => {
    if (!files.length || readingImagesRef.current || sendLocked) return;
    readingImagesRef.current = true;
    setReadingImages(true);
    setImageError(undefined);
    try {
      replaceImages(await readComposerImages(files, imagesRef.current));
      textareaRef.current?.focus({ preventScroll: true });
    } catch (error) {
      setImageError(
        error instanceof Error
          ? error.message
          : "Could not read images. Add them again.",
      );
    } finally {
      readingImagesRef.current = false;
      setReadingImages(false);
    }
  };

  const scheduleDraftStorage = () => {
    if (storageTimerRef.current !== undefined) {
      window.clearTimeout(storageTimerRef.current);
    }
    storageTimerRef.current = window.setTimeout(() => {
      storageTimerRef.current = undefined;
      storeDraft(storageKey, draftRef.current);
    }, DRAFT_STORAGE_DEBOUNCE_MS);
  };

  const syncTextareaHeight = () => {
    const textarea = textareaRef.current;
    if (!textarea || window.matchMedia(DESKTOP_MEDIA_QUERY).matches) return;
    const previous = textarea.style.height;
    textarea.style.height = "auto";
    const next = `${Math.min(textarea.scrollHeight, MOBILE_COMPOSER_MAX_HEIGHT_PX)}px`;
    textarea.style.height = previous === next ? previous : next;
  };

  const setMessage = (text: string) => {
    const current = draftRef.current;
    if (current.text === text) return;
    draftRef.current = { ...current, text };
    updateCanSend(text);
    scheduleDraftStorage();
  };

  const replaceMessage = (draft: ConversationDraft) => {
    draftRef.current = draft;
    const textarea = textareaRef.current;
    if (textarea) textarea.value = draft.text;
    updateCanSend(draft.text);
    syncTextareaHeight();
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = draftRef.current.text.trim();
    const submittedImages = imagesRef.current;
    if (
      (!text && !submittedImages.length) ||
      !online ||
      submittingRef.current ||
      sendLocked ||
      readingImagesRef.current
    )
      return;

    const attempt = conversationAttemptForSubmit(
      attemptRef.current,
      text,
      submittedImages.length ? submittedImages : undefined,
    );
    attemptRef.current = attempt;
    const submitToken = ++submitTokenRef.current;
    const submittedDraft: ConversationDraft = {
      idempotencyKey: attempt.idempotencyKey,
      lastSubmittedText: attempt.lastSubmittedText,
      hasImages: submittedImages.length > 0,
      text,
    };
    // Clear immediately so the reader can compose the next message. Existing
    // conversations keep failures in the mailbox outbox; new roots may restore.
    const nextAttempt = emptyDraft();
    const clearedDraft: ConversationDraft = {
      ...nextAttempt,
      text: "",
    };
    replaceMessage(clearedDraft);
    replaceImages([]);
    setImageError(undefined);
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
      await props.onSubmit(
        text,
        attempt.idempotencyKey,
        submittedImages.length ? submittedImages : undefined,
      );
    } catch {
      if (!props.restoreDraftOnError) {
        // Parent keeps the failed message in the mailbox queue for retry.
        return;
      }
      // Ignore stale failures after a newer submit owns the composer.
      if (submitToken !== submitTokenRef.current) return;
      // Restore only when the reader has not already started another draft.
      if (draftRef.current.text || imagesRef.current.length) return;
      replaceImages(submittedImages);
      replaceMessage(submittedDraft);
      attemptRef.current = attempt;
      storeDraft(storageKey, submittedDraft);
    } finally {
      if (props.restoreDraftOnError && submitToken === submitTokenRef.current) {
        submittingRef.current = false;
        setCreatePending(false);
      }
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div className="grid min-w-0 gap-1.5">
      {!online || props.error || imageError ? (
        <div
          aria-live="polite"
          className={
            !online
              ? "min-w-0 font-mono text-xs leading-relaxed text-amber-100/80"
              : "min-w-0 font-mono text-xs leading-relaxed text-red-300/80"
          }
        >
          {!online
            ? images.length
              ? "Connect to send. Image drafts stay here until you leave."
              : "Connect to send. Your draft is saved."
            : (imageError ?? props.error)}
        </div>
      ) : null}
      <form
        className={cn(
          // Accessory chrome needs a full footer row. Side-by-side mobile is
          // only for the bare reply dock.
          props.footerStart
            ? "block overflow-hidden focus-within:border-cyan-300/35 focus-within:ring-1 focus-within:ring-cyan-300/35"
            : "grid grid-cols-[minmax(0,1fr)_auto] items-end overflow-hidden focus-within:border-cyan-300/35 focus-within:ring-1 focus-within:ring-cyan-300/35 md:block",
          dashboardComposerSurfaceClass,
          dragging && "ring-2 ring-cyan-300",
        )}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setDragging(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setDragging(false);
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setDragging(false);
          void addImages(Array.from(event.dataTransfer.files));
        }}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files);
          if (!files.length) return;
          event.preventDefault();
          void addImages(files);
        }}
        onSubmit={submit}
      >
        {images.length ? (
          <ComposerImages
            images={images}
            disabled={readingImages || sendLocked}
            onRemove={(index) => {
              if (readingImagesRef.current || sendLocked) return;
              replaceImages(imagesRef.current.filter((_, i) => i !== index));
              setImageError(undefined);
            }}
          />
        ) : null}
        {dragging || readingImages ? (
          <div
            role="status"
            className="col-span-full px-3 pt-2 text-sm text-dashboard-text-muted"
          >
            {readingImages ? "Reading images…" : "Drop images here"}
          </div>
        ) : null}
        <input
          accept={INPUT_IMAGE_TYPES.join(",")}
          aria-label="Choose images"
          className="sr-only"
          multiple
          onChange={(event) => {
            void addImages(Array.from(event.currentTarget.files ?? []));
            event.currentTarget.value = "";
          }}
          ref={fileInputRef}
          tabIndex={-1}
          type="file"
        />
        <label className="sr-only" htmlFor={id}>
          {props.label}
        </label>
        <textarea
          // Chat is technical: ids, paths, code. Keep the keyboard chat-like
          // (Send) and suppress browser IME assist that fights identifiers.
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          className="min-h-12 max-h-28 w-full resize-none overflow-y-auto border-0 bg-transparent px-3 py-3 font-sans text-base leading-relaxed text-dashboard-text outline-none placeholder:text-dashboard-text-muted/65 md:min-h-14 md:max-h-none md:resize-y md:overflow-visible md:px-4 md:py-3"
          disabled={Boolean(props.restoreDraftOnError && createPending)}
          enterKeyHint="send"
          id={id}
          inputMode="text"
          maxLength={32_000}
          defaultValue={initialDraft.text}
          onChange={(event) => {
            setMessage(event.target.value);
            syncTextareaHeight();
          }}
          onFocus={props.onFocus}
          onKeyDown={handleKeyDown}
          placeholder="Message Junior…"
          ref={textareaRef}
          rows={1}
          spellCheck={false}
        />
        <div
          className={cn(
            "flex min-w-0 items-center gap-3 px-2 py-1.5 md:px-3 md:py-2",
            props.footerStart
              ? "justify-between"
              : "justify-end md:justify-between",
          )}
        >
          <div className="flex min-w-0 items-center gap-3">
            <Button
              aria-label="Attach images"
              disabled={sendLocked || readingImages}
              onClick={() => fileInputRef.current?.click()}
              title="Attach images (up to 3 MB total)"
              type="button"
            >
              <ImagePlus aria-hidden="true" size={16} />
            </Button>
            {props.footerStart}
            {props.footerStart ? null : (
              <div className="hidden min-w-0 font-sans text-xs leading-relaxed text-dashboard-text-muted md:block">
                Enter to send · Shift+Enter for a new line
              </div>
            )}
          </div>
          <Button
            aria-label={sendLocked ? "Sending message" : props.submitLabel}
            className="rounded-lg !border-0 !bg-cyan-100 font-sans !text-dashboard-text-inverse hover:!bg-cyan-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300/55 disabled:!bg-dashboard-fill-hover disabled:!text-dashboard-text-muted"
            disabled={
              (!canSend && !images.length) ||
              !online ||
              sendLocked ||
              readingImages
            }
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
        idempotencyKey:
          "hasImages" in draft && draft.hasImages
            ? crypto.randomUUID()
            : draft.idempotencyKey,
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
