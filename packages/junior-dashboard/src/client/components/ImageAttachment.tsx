import { ChevronLeft, ChevronRight, ExternalLink, X } from "lucide-react";
import {
  type MouseEvent,
  useState,
  type ComponentPropsWithoutRef,
} from "react";

import { Button } from "./ui/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "./ui/dialog";
import { useSheet } from "./ui/useSheet";

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

/** One image that a preview can show. */
export type PreviewImage = {
  context?: string;
  filename: string;
  src: string;
};

function samePreviewImage(a: PreviewImage, b: PreviewImage): boolean {
  return a.src === b.src && a.filename === b.filename;
}

/**
 * Render an image attachment that opens in a responsive modal on a normal
 * click. With a gallery that holds this image, the modal pages through it.
 */
export function ImageAttachment(
  props: {
    context?: string;
    filename: string;
    gallery?: readonly PreviewImage[];
    imageClassName?: string;
    src: string;
    triggerClassName?: string;
  } & Omit<ComponentPropsWithoutRef<"img">, "alt" | "className" | "src">,
) {
  const [open, setOpen] = useState(false);
  const {
    context,
    filename,
    gallery,
    imageClassName,
    src,
    triggerClassName,
    ...imageProps
  } = props;
  const self = { context, filename, src };
  const galleryIndex =
    gallery?.findIndex((image) => samePreviewImage(image, self)) ?? -1;

  return (
    <>
      <a
        className={triggerClassName}
        href={src}
        onClick={(event) => {
          if (!shouldPreviewImageAttachment(event)) return;
          event.preventDefault();
          setOpen(true);
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
      {open ? (
        <ImagePreview
          images={gallery && galleryIndex >= 0 ? gallery : [self]}
          initialIndex={Math.max(galleryIndex, 0)}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

const PREVIEW_NAV_BUTTON_CLASS =
  "h-10 w-10 border-0 bg-transparent p-0 text-dashboard-text-muted hover:bg-dashboard-fill-hover hover:text-dashboard-text";

/**
 * Show images above the page, one at a time. `useSheet` shares the document
 * scroll lock with sheets and keeps Escape and backdrop dismissal on the
 * front modal.
 */
function ImagePreview(props: {
  images: readonly PreviewImage[];
  initialIndex: number;
  onClose(): void;
}) {
  const sheet = useSheet(props.onClose);
  // Track the shown image, not its position. Transcript rows can load above
  // it while the preview is open, which moves its index.
  const [current, setCurrent] = useState(props.images[props.initialIndex]!);
  const count = props.images.length;
  const index = Math.max(
    props.images.findIndex((image) => samePreviewImage(image, current)),
    0,
  );
  const image = props.images[index]!;
  // Wrap at the ends. A disabled button would drop focus out of the dialog
  // and stop the arrow keys.
  const show = (next: number) =>
    setCurrent(props.images[(next + count) % count]!);

  return (
    <Dialog {...sheet.rootProps}>
      <DialogContent
        {...sheet.contentProps}
        className="top-0 left-0 h-dvh w-screen max-w-none translate-x-0 translate-y-0 gap-0 overflow-hidden rounded-none border-0 bg-dashboard-ink p-0 shadow-none max-h-none sm:top-0 sm:translate-y-0 md:top-1/2 md:left-1/2 md:h-[min(90dvh,960px)] md:w-[min(92vw,1440px)] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-lg md:border"
        onKeyDown={(event) => {
          if (count < 2) return;
          if (event.key === "ArrowLeft") show(index - 1);
          else if (event.key === "ArrowRight") show(index + 1);
          else return;
          event.preventDefault();
        }}
      >
        <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] bg-dashboard-bg-elevated">
          <header className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-1.5 border-b border-dashboard-border-strong bg-dashboard-surface-raised px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] md:px-4">
            <div className="min-w-0">
              <DialogTitle className="truncate font-mono text-xs leading-normal font-normal">
                {image.filename}
              </DialogTitle>
              {image.context ? (
                <div className="truncate font-mono text-2xs text-dashboard-text-muted">
                  {image.context}
                </div>
              ) : null}
            </div>
            {count > 1 ? (
              <div className="flex items-center gap-0.5">
                <Button
                  aria-label="Previous image"
                  className={PREVIEW_NAV_BUTTON_CLASS}
                  onClick={() => show(index - 1)}
                >
                  <ChevronLeft aria-hidden="true" size={16} />
                </Button>
                <span className="min-w-12 text-center font-mono text-xs text-dashboard-text-muted tabular-nums">
                  {index + 1} of {count}
                </span>
                <Button
                  aria-label="Next image"
                  className={PREVIEW_NAV_BUTTON_CLASS}
                  onClick={() => show(index + 1)}
                >
                  <ChevronRight aria-hidden="true" size={16} />
                </Button>
              </div>
            ) : (
              <span />
            )}
            <a
              className="inline-flex min-h-10 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-dashboard-text-muted no-underline transition-colors hover:bg-dashboard-fill-hover hover:text-dashboard-text"
              href={image.src}
              rel="noreferrer"
              target="_blank"
            >
              <ExternalLink aria-hidden="true" size={14} />
              <span className="max-sm:sr-only">Open raw file</span>
            </a>
            <DialogClose
              render={
                <Button className="h-10 gap-1.5 border-0 bg-transparent px-2.5 text-xs text-dashboard-text-muted hover:bg-dashboard-fill-hover hover:text-dashboard-text" />
              }
            >
              <X aria-hidden="true" size={16} />
              <span>Close</span>
            </DialogClose>
          </header>
          <div className="grid min-h-0 place-items-center overflow-auto p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:p-6">
            <img
              alt={image.filename}
              className="max-h-full max-w-full object-contain"
              key={image.src}
              src={image.src}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
