import { ExternalLink, X } from "lucide-react";
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
  const [open, setOpen] = useState(false);
  const {
    context,
    filename,
    imageClassName,
    src,
    triggerClassName,
    ...imageProps
  } = props;

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
          context={context}
          filename={filename}
          onClose={() => setOpen(false)}
          src={src}
        />
      ) : null}
    </>
  );
}

/**
 * Show one image above the page. `useSheet` shares the document scroll lock
 * with sheets and keeps Escape and backdrop dismissal on the front modal.
 */
function ImagePreview(props: {
  context?: string;
  filename: string;
  onClose(): void;
  src: string;
}) {
  const sheet = useSheet(props.onClose);
  return (
    <Dialog {...sheet.rootProps}>
      <DialogContent
        {...sheet.contentProps}
        className="top-0 left-0 h-dvh w-screen max-w-none translate-x-0 translate-y-0 gap-0 overflow-hidden rounded-none border-0 bg-dashboard-ink p-0 shadow-none sm:max-w-none md:top-1/2 md:left-1/2 md:h-[min(90dvh,960px)] md:w-[min(92vw,1440px)] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-lg md:border"
      >
        <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] bg-dashboard-bg-elevated">
          <header className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-1.5 border-b border-dashboard-border-strong bg-dashboard-surface-raised px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] md:px-4">
            <div className="min-w-0">
              <DialogTitle className="truncate font-mono text-xs leading-normal font-normal">
                {props.filename}
              </DialogTitle>
              {props.context ? (
                <div className="truncate font-mono text-2xs text-dashboard-text-muted">
                  {props.context}
                </div>
              ) : null}
            </div>
            <a
              className="inline-flex min-h-10 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-dashboard-text-muted no-underline transition-colors hover:bg-dashboard-fill-hover hover:text-dashboard-text"
              href={props.src}
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
              alt={props.filename}
              className="max-h-full max-w-full object-contain"
              src={props.src}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
