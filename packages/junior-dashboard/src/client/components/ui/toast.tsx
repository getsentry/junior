import * as React from "react";
import { Toast as ToastPrimitive } from "@base-ui/react/toast";
import { cn } from "@dashboard/lib/utils";

import { DESKTOP_LAYOUT_QUERY } from "../../layoutMedia";

import { Button } from "./button";
import {
  XIcon,
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
  Loader2Icon,
} from "lucide-react";

function ToastProvider({ ...props }: ToastPrimitive.Provider.Props) {
  return <ToastPrimitive.Provider {...props} />;
}

function ToastPortal({ ...props }: ToastPrimitive.Portal.Props) {
  return <ToastPrimitive.Portal data-slot="toast-portal" {...props} />;
}

// A phone puts toasts at the top, away from the composer, the keyboard,
// and the "+" button, so a tap meant for them cannot land on a toast. They
// follow the visual viewport pan that `useMobileViewportHeight` publishes.
type ToastEdge = "top" | "bottom";

function subscribeToLayout(onChange: () => void) {
  const media = window.matchMedia(DESKTOP_LAYOUT_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function useToastEdge(): ToastEdge {
  return React.useSyncExternalStore(
    subscribeToLayout,
    () => (window.matchMedia(DESKTOP_LAYOUT_QUERY).matches ? "bottom" : "top"),
    () => "bottom",
  );
}

function ToastViewport({
  className,
  edge,
  ...props
}: ToastPrimitive.Viewport.Props & { edge: ToastEdge }) {
  return (
    <ToastPrimitive.Viewport
      data-slot="toast-viewport"
      className={cn(
        "pointer-events-none fixed z-[60] outline-none",
        edge === "top"
          ? "inset-x-3 top-[calc(var(--dashboard-viewport-offset-top,0px)+max(0.75rem,env(safe-area-inset-top)))] mx-auto max-w-sm"
          : "right-4 bottom-[max(5.25rem,env(safe-area-inset-bottom))] w-full max-w-sm",
        className,
      )}
      {...props}
    />
  );
}

// Each edge stacks its toasts away from the screen edge, and a toast comes
// in and goes out across that edge.
const TOAST_EDGE_CLASS: Record<ToastEdge, string> = {
  bottom: cn(
    "bottom-0 origin-bottom",
    "[--offset-y:calc(var(--toast-offset-y)*-1+calc(var(--toast-index)*var(--gap)*-1)+var(--toast-swipe-movement-y))]",
    "[transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--peek))-(var(--shrink)*var(--height))))_scale(var(--scale))]",
    "after:top-full",
    "data-starting-style:[transform:translateY(150%)]",
    "[&[data-ending-style]:not([data-limited]):not([data-swipe-direction])]:[transform:translateY(150%)]",
  ),
  top: cn(
    "top-0 origin-top",
    "[--offset-y:calc(var(--toast-offset-y)+calc(var(--toast-index)*var(--gap))+var(--toast-swipe-movement-y))]",
    "[transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)+(var(--toast-index)*var(--peek))+(var(--shrink)*var(--height))))_scale(var(--scale))]",
    "after:bottom-full",
    "data-starting-style:[transform:translateY(-150%)]",
    "[&[data-ending-style]:not([data-limited]):not([data-swipe-direction])]:[transform:translateY(-150%)]",
  ),
};

function Toast({
  className,
  edge,
  ...props
}: ToastPrimitive.Root.Props & { edge: ToastEdge }) {
  return (
    <ToastPrimitive.Root
      data-slot="toast"
      swipeDirection={edge === "top" ? ["up", "right"] : ["down", "right"]}
      className={cn(
        "group/toast pointer-events-auto absolute right-0 z-[calc(1000-var(--toast-index))] w-full rounded-lg border border-input bg-secondary text-foreground shadow-lg will-change-transform outline-none select-none focus-visible:outline-2 focus-visible:outline-ring",
        "[--gap:0.75rem] [--height:var(--toast-frontmost-height,var(--toast-height))] [--peek:0.75rem] [--scale:calc(max(0,1-(var(--toast-index)*0.1)))] [--shrink:calc(1-var(--scale))]",
        "h-(--height) [transition:transform_180ms_ease-out,opacity_180ms,height_180ms] motion-reduce:transition-none",
        "after:absolute after:left-0 after:h-[calc(var(--gap)+1px)] after:w-full after:content-['']",
        TOAST_EDGE_CLASS[edge],
        "data-expanded:h-(--toast-height) data-expanded:[transform:translateX(var(--toast-swipe-movement-x))_translateY(var(--offset-y))]",
        "data-limited:opacity-0",
        "data-ending-style:data-[swipe-direction=down]:[transform:translateY(calc(var(--toast-swipe-movement-y)+150%))]",
        "data-ending-style:data-[swipe-direction=left]:[transform:translateX(calc(var(--toast-swipe-movement-x)-150%))_translateY(var(--offset-y))]",
        "data-ending-style:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-movement-x)+150%))_translateY(var(--offset-y))]",
        "data-ending-style:data-[swipe-direction=up]:[transform:translateY(calc(var(--toast-swipe-movement-y)-150%))]",
        "data-expanded:data-ending-style:data-[swipe-direction=down]:[transform:translateY(calc(var(--toast-swipe-movement-y)+150%))]",
        "data-expanded:data-ending-style:data-[swipe-direction=left]:[transform:translateX(calc(var(--toast-swipe-movement-x)-150%))_translateY(var(--offset-y))]",
        "data-expanded:data-ending-style:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-movement-x)+150%))_translateY(var(--offset-y))]",
        "data-expanded:data-ending-style:data-[swipe-direction=up]:[transform:translateY(calc(var(--toast-swipe-movement-y)-150%))]",
        className,
      )}
      {...props}
    />
  );
}

function ToastContent({ className, ...props }: ToastPrimitive.Content.Props) {
  return (
    <ToastPrimitive.Content
      data-slot="toast-content"
      className={cn(
        "flex h-full items-center gap-3 overflow-hidden p-4 max-md:gap-2 max-md:py-1.5 max-md:pr-1.5 max-md:pl-3 transition-opacity duration-180 motion-reduce:transition-none ease-[cubic-bezier(0.22,1,0.36,1)] data-behind:opacity-0 data-expanded:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

function ToastTitle({ className, ...props }: ToastPrimitive.Title.Props) {
  return (
    <ToastPrimitive.Title
      data-slot="toast-title"
      className={cn(
        "break-words text-sm font-medium max-md:truncate",
        className,
      )}
      {...props}
    />
  );
}

function ToastDescription({
  className,
  ...props
}: ToastPrimitive.Description.Props) {
  return (
    <ToastPrimitive.Description
      data-slot="toast-description"
      className={cn("break-words text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

function ToastAction({
  className,
  render = <Button variant="outline" />,
  ...props
}: ToastPrimitive.Action.Props) {
  return (
    <ToastPrimitive.Action
      data-slot="toast-action"
      render={render}
      className={cn("shrink-0", className)}
      {...props}
    />
  );
}

function ToastClose({
  className,
  children,
  render = <Button size="icon" variant="ghost" />,
  ...props
}: ToastPrimitive.Close.Props) {
  return (
    <ToastPrimitive.Close
      data-slot="toast-close"
      aria-label="Close toast"
      render={render}
      className={cn(
        "relative shrink-0 text-muted-foreground after:absolute after:-inset-2 after:content-[''] hover:text-foreground",
        className,
      )}
      {...props}
    >
      {children ?? <XIcon aria-hidden="true" />}
    </ToastPrimitive.Close>
  );
}

function ToastIcon({ type }: { type: string | undefined }) {
  let icon: React.ReactNode = null;

  if (type === "success") {
    icon = <CircleCheckIcon aria-hidden="true" />;
  }

  if (type === "info") {
    icon = <InfoIcon aria-hidden="true" />;
  }

  if (type === "warning") {
    icon = <TriangleAlertIcon aria-hidden="true" />;
  }

  if (type === "error") {
    icon = <OctagonXIcon className="text-rose-300" aria-hidden="true" />;
  }

  if (type === "loading") {
    icon = (
      <Loader2Icon
        className="animate-spin motion-reduce:animate-none"
        aria-hidden="true"
      />
    );
  }

  if (!icon) {
    return null;
  }

  return (
    <span
      data-slot="toast-icon"
      className="shrink-0 translate-y-0.5 max-md:translate-y-0 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4"
    >
      {icon}
    </span>
  );
}

function ToastList(props: { edge: ToastEdge }) {
  const { toasts } = ToastPrimitive.useToastManager();

  return toasts.map((toastItem) => (
    <Toast edge={props.edge} key={toastItem.id} toast={toastItem}>
      <ToastContent>
        {/* Top-align the icon with the title, like Alert; buttons stay centered.
            A phone shows one line: the title and its buttons. */}
        <div className="flex min-w-0 flex-1 items-start gap-3 max-md:items-center max-md:gap-2">
          <ToastIcon type={toastItem.type} />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <ToastTitle />
            {/* A description with links, such as Settings, is an action. */}
            <ToastDescription
              className={
                typeof toastItem.description === "string"
                  ? "max-md:hidden"
                  : undefined
              }
            />
          </div>
        </div>
        {/* ToastAction reads actionProps from the toast; spreading them too runs onClick twice. */}
        {toastItem.actionProps ? <ToastAction /> : null}
        <ToastClose />
      </ToastContent>
    </Toast>
  ));
}

const CONFIRMATION_TIMEOUT_MS = 2_500;

/** Own notification state for one mounted dashboard and render its toast stack. */
function Toaster({ children, ...props }: ToastPrimitive.Provider.Props) {
  const edge = useToastEdge();
  return (
    <ToastProvider limit={3} timeout={4000} {...props}>
      {children}
      <ToastPortal>
        <ToastViewport edge={edge}>
          <ToastList edge={edge} />
        </ToastViewport>
      </ToastPortal>
    </ToastProvider>
  );
}

/**
 * Show short notifications through the nearest mounted Toaster. A success
 * toast with no action goes away sooner: it only confirms.
 */
function useToastManager() {
  const manager = ToastPrimitive.useToastManager();
  const { add: addToast } = manager;
  const add = React.useCallback<typeof addToast>(
    (options) =>
      addToast({
        ...(options.type === "success" && !options.actionProps
          ? { timeout: CONFIRMATION_TIMEOUT_MS }
          : undefined),
        ...options,
      }),
    [addToast],
  );
  return { ...manager, add };
}

export { Toaster, useToastManager };
