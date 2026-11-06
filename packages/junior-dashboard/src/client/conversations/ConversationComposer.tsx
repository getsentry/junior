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
  useSyncExternalStore,
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
import { useComposerAutocorrect } from "./composerAutocorrect";
import { useSwipeDownToBlur } from "./useSwipeDownToBlur";

const DRAFT_STORAGE_PREFIX = "junior:dashboard:conversation-draft:";
// Keep keystrokes off the storage path. Mobile Safari pays for every write.
const DRAFT_STORAGE_DEBOUNCE_MS = 250;
// Touch keyboards have no Shift+Enter, so Return adds a line there and the
// send button sends.
const TOUCH_KEYBOARD_QUERY = "(pointer: coarse)";

function subscribeToTouchKeyboard(onChange: () => void) {
  const media = window.matchMedia(TOUCH_KEYBOARD_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function touchKeyboardMatches() {
  return window.matchMedia(TOUCH_KEYBOARD_QUERY).matches;
}

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

/** Imperative composer actions for the reply footer and the create view. */
export type ConversationComposerHandle = {
  /** True when the draft has room for these images right now. */
  canRestoreImages(images: readonly InputImage[]): boolean;
  /** Put the cursor in the draft. */
  focus(): void;
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
  /** Text only, for a narrow panel: no images, no key hint, icon-only send. */
  compact?: boolean;
  label: string;
  placeholder?: string;
  /**
   * Keep the draft in place and locked until `onSubmit` resolves, then clear
   * it. Use it when no mailbox outbox shows the send (new Conversation, Quick
   * question): the text leaves the composer when it shows somewhere else. A
   * failure keeps the draft and its send key for a retry.
   */
  holdDraftUntilAccept?: boolean;
  /** Lets the parent put a message taken out of the queue back in the draft. */
  ref?: Ref<ConversationComposerHandle>;
  submitLabel: string;
  /**
   * Return a promise to ask the reader before a send. The draft stays when it
   * resolves false. Return undefined to send at once.
   */
  confirmSubmit?: () => Promise<boolean> | undefined;
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
  const [holdPending, setHoldPending] = useState(false);
  const [canSend, setCanSend] = useState(() =>
    Boolean(initialDraft.text.trim()),
  );
  const [images, setImages] = useState<InputImage[]>([]);
  const imagesRef = useRef(images);
  const [imageError, setImageError] = useState<string>();
  const [readingImages, setReadingImages] = useState(false);
  const readingImagesRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const replyLayout = !props.footerStart && !props.compact;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const online = useDashboardOnline();
  const [autocorrect] = useComposerAutocorrect();
  const enterSends = !useSyncExternalStore(
    subscribeToTouchKeyboard,
    touchKeyboardMatches,
    () => false,
  );
  const id = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useSwipeDownToBlur(textareaRef);
  const draftRef = useRef(initialDraft);
  const canSendRef = useRef(canSend);
  const storageTimerRef = useRef<number | undefined>(undefined);
  // Source of truth for the in-flight attempt. React state alone is too late for
  // a second Enter before the parent pending flag flips.
  const attemptRef = useRef<ConversationAttempt>({
    idempotencyKey: initialDraft.idempotencyKey,
    lastSubmittedText: initialDraft.lastSubmittedText,
  });
  // Blocks same-tick double fire. A held draft also blocks until settle.
  const submittingRef = useRef(false);
  // Blocks a second send while the reader answers `confirmSubmit`.
  const confirmingRef = useRef(false);
  const stoppingRef = useRef(false);
  const sendLocked = Boolean(props.disabled) || holdPending;

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
  // longer drafts scroll inside it. Measure again when the text rewraps or
  // the reply layout switches density.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    syncComposerHeight(textarea);
    let width = textarea.clientWidth;
    let frame: number | undefined;
    const scheduleHeight = () => {
      // A height change inside this callback starts a ResizeObserver loop
      // error. Measure in the next frame instead.
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        syncComposerHeight(textarea);
      });
    };
    const observer = new ResizeObserver(() => {
      if (textarea.clientWidth === width) return;
      width = textarea.clientWidth;
      scheduleHeight();
    });
    observer.observe(textarea);
    const tallViewport = replyLayout
      ? window.matchMedia("(min-height: 62.5rem)")
      : undefined;
    tallViewport?.addEventListener("change", scheduleHeight);
    return () => {
      observer.disconnect();
      tallViewport?.removeEventListener("change", scheduleHeight);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [replyLayout]);

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

  const canSubmit = () =>
    Boolean(draftRef.current.text.trim() || imagesRef.current.length) &&
    online &&
    !submittingRef.current &&
    !confirmingRef.current &&
    !sendLocked &&
    !readingImagesRef.current;

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSubmit()) return;
    const confirmation = props.confirmSubmit?.();
    if (confirmation) {
      confirmingRef.current = true;
      let confirmed: boolean;
      try {
        confirmed = await confirmation;
      } finally {
        confirmingRef.current = false;
      }
      if (!confirmed) return;
    }
    const text = draftRef.current.text.trim();
    const submittedImages = imagesRef.current;

    const attempt = conversationAttemptForSubmit(
      attemptRef.current,
      text,
      submittedImages.length ? submittedImages : undefined,
    );
    attemptRef.current = attempt;
    const send = () =>
      props.onSubmit(
        text,
        attempt.idempotencyKey,
        submittedImages.length ? submittedImages : undefined,
      );
    const clear = () => {
      const nextAttempt = emptyDraft();
      const clearedDraft: ConversationDraft = { ...nextAttempt, text: "" };
      replaceMessage(clearedDraft);
      replaceImages([]);
      setImageError(undefined);
      storeDraft(storageKey, clearedDraft);
      attemptRef.current = nextAttempt;
    };
    submittingRef.current = true;
    props.onSubmitStart?.();

    if (props.holdDraftUntilAccept) {
      // Save the send key with the draft, so a retry after a reload reuses it.
      const heldDraft: ConversationDraft = {
        ...draftRef.current,
        idempotencyKey: attempt.idempotencyKey,
        lastSubmittedText: attempt.lastSubmittedText,
        hasImages: submittedImages.length > 0,
      };
      draftRef.current = heldDraft;
      storeDraft(storageKey, heldDraft);
      setHoldPending(true);
      try {
        await send();
      } catch {
        // The parent shows the error. The draft stays for a retry.
        return;
      } finally {
        submittingRef.current = false;
        setHoldPending(false);
      }
      clear();
      return;
    }

    // Clear at once so the reader can compose the next message. The parent
    // keeps a failed send in the mailbox outbox for retry.
    clear();
    textareaRef.current?.focus({ preventScroll: true });
    queueMicrotask(() => {
      submittingRef.current = false;
    });
    await send().catch(() => {});
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
    focus: () => textareaRef.current?.focus({ preventScroll: true }),
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
      enterSends &&
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
            : "grid grid-cols-[minmax(0,1fr)_auto] items-end overflow-hidden focus-within:border-dashboard-accent/35 focus-within:ring-1 focus-within:ring-dashboard-focus/35",
          // A compact form has only the send button: keep it beside the text.
          replyLayout && "md:block",
          dashboardComposerSurfaceClass,
          dragging && "ring-2 ring-dashboard-focus",
        )}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          // Always cancel a file drop, or the browser opens the file.
          event.preventDefault();
          if (props.compact) {
            event.dataTransfer.dropEffect = "none";
            return;
          }
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
          if (props.compact) return;
          setDragging(false);
          void addImages(Array.from(event.dataTransfer.files));
        }}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files);
          if (props.compact || !files.length) return;
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
          // Chat is technical: ids, paths, code. Suppress browser IME assist
          // that fights identifiers, unless the user turns autocorrect on in
          // settings.
          autoCapitalize={autocorrect ? "sentences" : "off"}
          autoComplete="off"
          autoCorrect={autocorrect ? "on" : "off"}
          className={cn(
            "min-h-12 max-h-28 w-full resize-none overflow-y-auto border-0 bg-transparent px-3 py-3 font-sans text-base leading-relaxed text-dashboard-text outline-none placeholder:text-dashboard-text-faint",
            props.compact
              ? "md:max-h-[min(calc(8lh_+_1.5rem),30dvh)] md:text-sm"
              : "md:max-h-[min(calc(12lh_+_1.5rem),40dvh)] md:px-4",
            replyLayout
              ? "md:py-2 md:tall:min-h-14 md:tall:py-3"
              : !props.compact && "md:min-h-14",
          )}
          disabled={holdPending}
          enterKeyHint={enterSends ? "send" : "enter"}
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
          placeholder={props.placeholder ?? "Message Junior…"}
          ref={textareaRef}
          rows={1}
          spellCheck={autocorrect}
        />
        <div
          className={cn(
            "flex min-w-0 items-center gap-3 px-2 py-1.5",
            !props.compact && "md:px-3",
            replyLayout ? "md:tall:py-2" : !props.compact && "md:py-2",
            props.footerStart
              ? "justify-between"
              : "justify-end md:justify-between",
          )}
        >
          <div className="flex min-w-0 items-center gap-3">
            {props.compact ? null : (
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
            )}
            {props.footerStart}
            {props.footerStart || props.compact || !enterSends ? null : (
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
              className={cn(
                "disabled:!border-transparent disabled:!bg-dashboard-fill-hover disabled:!text-dashboard-text-muted disabled:!opacity-100",
                props.compact && "w-9 px-0",
              )}
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
              {props.compact ? null : (
                <span className="hidden md:inline">
                  {sendLocked ? "Sending…" : props.submitLabel}
                </span>
              )}
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
