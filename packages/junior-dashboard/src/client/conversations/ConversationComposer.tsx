import { INPUT_IMAGE_TYPES, type InputImage } from "@sentry/junior/api/schema";
import {
  ComposerImages,
  composerImagesFit,
  readComposerImages,
} from "./ComposerImages";
import {
  memo,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { ImagePlus, Send, Square } from "lucide-react";

import { Button } from "../components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { useDashboardOnline } from "../connection";
import { cn, dashboardComposerSurfaceClass } from "../styles";

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

/** Imperative composer actions for the reply footer. */
export type ConversationComposerHandle = {
  /** True when the draft has room for these images right now. */
  canRestoreImages(images: readonly InputImage[]): boolean;
  /** Put queued text and images ahead of the draft. Queued images win. */
  restoreMessage(message: { images?: InputImage[]; text: string }): void;
};

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
  /** Lets the parent put a message taken out of the queue back in the draft. */
  ref?: Ref<ConversationComposerHandle>;
  submitLabel: string;
  onFocus?: () => void;
  onSubmit(
    message: string,
    idempotencyKey: string,
    images?: InputImage[],
  ): Promise<void>;
  onSubmitStart?: () => void;
  /**
   * Stop the active Turn. Present only while a Turn can be stopped. Resolves
   * with queued text that the stop removed, which returns to the draft.
   */
  onStop?: () => Promise<string | undefined>;
  stopPending?: boolean;
};

/** Render the dashboard message composer for a new or existing conversation. */
export const ConversationComposer = memo(function ConversationComposer(
  props: ConversationComposerProps,
) {
  const storageKey = draftStorageKey(props.draftId);
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
  const stoppingRef = useRef(false);
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

  // Grow with wrapped and explicit lines. CSS `max-height` caps the box, and
  // longer drafts scroll inside it. Width changes rewrap the text, so measure
  // again when the textarea gets narrower or wider.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    syncComposerHeight(textarea);
    let width = textarea.clientWidth;
    let frame: number | undefined;
    const observer = new ResizeObserver(() => {
      if (textarea.clientWidth === width) return;
      width = textarea.clientWidth;
      // A height change inside this callback starts a ResizeObserver loop
      // error. Measure in the next frame instead.
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        syncComposerHeight(textarea);
      });
    });
    observer.observe(textarea);
    return () => {
      observer.disconnect();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
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
      const before = imagesRef.current;
      const added = (await readComposerImages(files, before)).slice(
        before.length,
      );
      // An edit can restore images during the read. Add to those images
      // instead of replacing them.
      const next = [...imagesRef.current, ...added];
      if (!composerImagesFit(next)) {
        setImageError("Attach up to 3 images that total 3 MB or less.");
      } else {
        replaceImages(next);
      }
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
    if (textareaRef.current) syncComposerHeight(textareaRef.current);
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

  // Put queued text back ahead of anything the reader already typed.
  const prependDraftText = (text: string) => {
    const next = withPrependedText(draftRef.current, text);
    replaceMessage(next);
    storeDraft(storageKey, next);
  };

  const stopTurn = async () => {
    if (!props.onStop || stoppingRef.current) return;
    stoppingRef.current = true;
    let restored: string | undefined;
    try {
      restored = await props.onStop();
    } catch {
      // The parent owns the stop error message.
      return;
    } finally {
      stoppingRef.current = false;
    }
    if (!restored) return;
    prependDraftText(restored);
    textareaRef.current?.focus({ preventScroll: true });
  };

  useImperativeHandle(props.ref, () => ({
    canRestoreImages: (images) =>
      !images.length || composerImagesFit([...images, ...imagesRef.current]),
    restoreMessage: (message) => {
      // An image-only message has no text to put ahead of the draft.
      if (message.text.trim()) prependDraftText(message.text);
      const restoredImages = message.images ?? [];
      if (restoredImages.length) {
        // The queued images already left the queue, so they win. A draft
        // image added during the cancel stays only while it still fits.
        const merged = [...restoredImages];
        for (const image of imagesRef.current) {
          if (composerImagesFit([...merged, image])) merged.push(image);
        }
        if (merged.length < restoredImages.length + imagesRef.current.length) {
          setImageError("Some draft images did not fit. Add them again.");
        }
        replaceImages(merged);
      }
      textareaRef.current?.focus({ preventScroll: true });
    },
  }));

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
      {props.error || imageError ? (
        <div
          aria-live="polite"
          className="min-w-0 font-sans text-xs leading-relaxed text-rose-300"
        >
          {imageError ?? props.error}
        </div>
      ) : null}
      <form
        className={cn(
          // Accessory chrome needs a full footer row. Side-by-side mobile is
          // only for the bare reply dock.
          props.footerStart
            ? "block overflow-hidden focus-within:border-dashboard-focus/45 focus-within:ring-1 focus-within:ring-dashboard-focus/25"
            : "grid grid-cols-[minmax(0,1fr)_auto] items-end overflow-hidden focus-within:border-dashboard-accent/35 focus-within:ring-1 focus-within:ring-dashboard-focus/35 md:block",
          dashboardComposerSurfaceClass,
          dragging && "ring-2 ring-dashboard-focus",
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
          className="min-h-12 max-h-28 w-full resize-none overflow-y-auto border-0 bg-transparent px-3 py-3 font-sans text-base leading-relaxed text-dashboard-text outline-none placeholder:text-dashboard-text-muted/65 md:min-h-14 md:max-h-[min(calc(12lh_+_1.5rem),40dvh)] md:px-4 md:py-3"
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
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    focusableWhenDisabled
                    aria-label="Attach images"
                    disabled={sendLocked || readingImages}
                    onClick={() => fileInputRef.current?.click()}
                    size="icon"
                    type="button"
                  >
                    <ImagePlus aria-hidden="true" size={16} />
                  </Button>
                }
              />
              <TooltipContent size="compact">
                Attach images (up to 3 MB total)
              </TooltipContent>
            </Tooltip>
            {props.footerStart}
            {props.footerStart ? null : (
              <div className="hidden min-w-0 font-sans text-xs leading-relaxed text-dashboard-text-muted md:block">
                Enter to send · Shift+Enter for a new line
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {props.onStop ? (
              <Button
                aria-label={props.stopPending ? "Stopping" : "Stop"}
                disabled={props.stopPending || !online}
                onClick={() => void stopTurn()}
              >
                <Square aria-hidden="true" fill="currentColor" size={12} />
                <span className="hidden md:inline">
                  {props.stopPending ? "Stopping…" : "Stop"}
                </span>
              </Button>
            ) : null}
            <Button
              aria-label={sendLocked ? "Sending message" : props.submitLabel}
              className="disabled:!border-transparent disabled:!bg-dashboard-fill-hover disabled:!text-dashboard-text-muted disabled:!opacity-100"
              disabled={
                (!canSend && !images.length) ||
                !online ||
                sendLocked ||
                readingImages
              }
              variant="primary"
              type="submit"
            >
              <Send aria-hidden="true" size={14} />
              <span className="hidden md:inline">
                {sendLocked ? "Sending…" : props.submitLabel}
              </span>
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
});

/** Fit the textarea to its text. CSS `max-height` sets the scroll limit. */
function syncComposerHeight(textarea: HTMLTextAreaElement): void {
  // Measure from auto height so the box can also shrink after deletes.
  const previous = textarea.style.height;
  textarea.style.height = "auto";
  const next = `${textarea.scrollHeight}px`;
  textarea.style.height = previous === next ? previous : next;
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

function draftStorageKey(draftId: string): string {
  return `${DRAFT_STORAGE_PREFIX}${encodeURIComponent(draftId)}`;
}

function withPrependedText(
  draft: ConversationDraft,
  text: string,
): ConversationDraft {
  return {
    ...draft,
    text: draft.text.trim() ? `${text}\n${draft.text}` : text,
  };
}

/**
 * Put queued text ahead of the saved draft when the composer is not mounted.
 * The composer reads the saved draft the next time it opens.
 */
export function restoreStoredDraftText(draftId: string, text: string): void {
  if (!text.trim()) return;
  const storageKey = draftStorageKey(draftId);
  storeDraft(storageKey, withPrependedText(readStoredDraft(storageKey), text));
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
