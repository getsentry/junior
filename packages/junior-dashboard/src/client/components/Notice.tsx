import type { ComponentProps, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "../styles";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";

type NoticeTone = "default" | "error";

type NoticeProps = {
  action?: ReactNode;
  children?: ReactNode;
  detail?: ReactNode;
  icon?: LucideIcon;
  title: ReactNode;
  tone?: NoticeTone;
};

type NoticeActionProps = ComponentProps<typeof Button> & {
  tone?: NoticeTone;
};

/** Render a short dashboard message with consistent status semantics and layout. */
export function Notice({
  action,
  children,
  detail,
  icon: Icon,
  title,
  tone = "default",
}: NoticeProps) {
  const isError = tone === "error";
  return (
    <Alert
      className="block gap-0 overflow-hidden rounded-xl p-0 shadow-[0_16px_40px_rgba(0,0,0,0.5)]"
      role={isError ? "alert" : "status"}
      variant={isError ? "destructive" : "default"}
    >
      <div className="flex min-w-0 items-center gap-3 px-3 py-3">
        {Icon ? (
          <div
            className={cn(
              "grid size-8 shrink-0 place-items-center rounded-lg",
              isError
                ? "bg-rose-300/15 text-rose-100"
                : "bg-dashboard-accent/10 text-dashboard-accent-text/80",
            )}
          >
            <Icon aria-hidden="true" size={16} />
          </div>
        ) : null}
        <div className="min-w-0 flex-1">
          <AlertTitle className="font-display text-sm leading-snug">
            {title}
            {detail ? " " : null}
          </AlertTitle>
          {detail ? (
            <AlertDescription
              className={cn(
                "mt-0.5 truncate font-sans text-xs",
                isError && "text-rose-100/70",
              )}
            >
              {detail}
            </AlertDescription>
          ) : null}
        </div>
        {action}
      </div>
      {children}
    </Alert>
  );
}

/** Render an action that fits the dashboard notice surface. */
export function NoticeAction({
  className,
  tone = "default",
  ...props
}: NoticeActionProps) {
  const isError = tone === "error";
  return (
    <Button
      {...props}
      className={cn(
        "h-auto shrink-0 rounded-lg border-0 px-3 py-1.5 text-xs leading-normal",
        isError
          ? "bg-rose-200/15 text-rose-50 hover:bg-rose-200/25 hover:text-rose-50 focus-visible:outline-rose-300/55 data-disabled:hover:bg-rose-200/15 data-disabled:hover:text-rose-50"
          : "bg-dashboard-accent/10 text-dashboard-accent-text hover:bg-dashboard-accent/20 hover:text-dashboard-accent-text data-disabled:hover:bg-dashboard-accent/10 data-disabled:hover:text-dashboard-accent-text",
        className,
      )}
    />
  );
}
