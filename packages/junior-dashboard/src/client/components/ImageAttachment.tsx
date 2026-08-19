import { ExternalLink, X } from "lucide-react";
import {
  type MouseEvent,
  useEffect,
  useId,
  useRef,
  type ComponentPropsWithoutRef,
} from "react";

/** Return true when an image link click should open the inline preview. */
export function shouldPreviewImageAttachment(
  event: Pick<
    MouseEvent<HTMLAnchorElement>,
    | "altKey"
    | "button"
    | "ctrlKey"
    | "defaultPrevented"
    | "metaKey"
    | "shiftKey"
  >,
): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  );
}

/** Render an image attachment that opens in a responsive modal on a normal click. */
export function ImageAttachment(
  props: {
    context?: string;
    filename: string;
    imageClassName?: string;
    src: string;
    triggerClassName?: string;
  } & Omit<ComponentPropsWithoutRef<"img">, "alt" | "className" | "src">,
) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const previousBodyOverflowRef = useRef<string | undefined>(undefined);
  const titleId = useId();
  const {
    context,
    filename,
    imageClassName,
    src,
    triggerClassName,
    ...imageProps
  } = props;

  const unlockBodyScroll = () => {
    if (previousBodyOverflowRef.current === undefined) return;
    document.body.style.overflow = previousBodyOverflowRef.current;
    previousBodyOverflowRef.current = undefined;
  };

  const close = () => {
    dialogRef.current?.close();
    unlockBodyScroll();
  };

  useEffect(() => () => unlockBodyScroll(), []);

  return (
    <>
      <a
        className={triggerClassName}
        href={src}
        onClick={(event) => {
          if (!shouldPreviewImageAttachment(event)) return;
          event.preventDefault();
          const dialog = dialogRef.current;
          if (!dialog || dialog.open) return;
          previousBodyOverflowRef.current = document.body.style.overflow;
          document.body.style.overflow = "hidden";
          dialog.showModal();
        }}
        rel="noreferrer"
        target="_blank"
      >
        <img
          {...imageProps}
          alt={filename}
          className={imageClassName}
          src={src}
        />
      </a>
      <dialog
        aria-labelledby={titleId}
        className="m-0 h-dvh max-h-none w-screen max-w-none overflow-hidden border-0 bg-black p-0 text-dashboard-text backdrop:bg-black/80 md:m-auto md:h-[min(90dvh,960px)] md:w-[min(92vw,1440px)] md:rounded-lg md:border md:border-white/15"
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
        onClose={unlockBodyScroll}
        ref={dialogRef}
      >
        <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] bg-[#070707]">
          <header className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-1.5 border-b border-white/10 bg-dashboard-surface-raised px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] md:px-4">
            <div className="min-w-0">
              <div
                className="truncate font-mono text-xs text-dashboard-text"
                id={titleId}
              >
                {filename}
              </div>
              {context ? (
                <div className="truncate font-mono text-2xs text-dashboard-text-muted">
                  {context}
                </div>
              ) : null}
            </div>
            <a
              className="inline-flex min-h-10 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-dashboard-text-muted no-underline transition-colors hover:bg-white/[0.06] hover:text-dashboard-text"
              href={src}
              rel="noreferrer"
              target="_blank"
            >
              <ExternalLink aria-hidden="true" size={14} />
              <span className="max-sm:sr-only">Open raw file</span>
            </a>
            <button
              aria-label="Close image preview"
              className="grid size-10 place-items-center rounded-md text-dashboard-text-muted transition-colors hover:bg-white/[0.06] hover:text-dashboard-text"
              onClick={close}
              type="button"
            >
              <X aria-hidden="true" size={18} />
            </button>
          </header>
          <div className="grid min-h-0 place-items-center overflow-auto p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:p-6">
            <img
              alt={filename}
              className="max-h-full max-w-full object-contain"
              src={src}
            />
          </div>
        </div>
      </dialog>
    </>
  );
}
