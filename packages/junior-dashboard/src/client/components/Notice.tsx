import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "../styles";

type NoticeTone = "default" | "error";

type NoticeProps = {
  action?: ReactNode;
  children?: ReactNode;
  detail?: ReactNode;
  icon?: LucideIcon;
  title: ReactNode;
  tone?: NoticeTone;
};

type NoticeActionProps = ButtonHTMLAttributes<HTMLButtonElement> & {
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
    <div
      className={cn(
        "overflow-hidden rounded-xl shadow-[0_16px_40px_var(--color-dashboard-shadow-notice)]",
        isError ? "bg-dashboard-notice-error" : "bg-dashboard-popover",
      )}
    >
      <div className="flex min-w-0 items-center gap-3 px-3 py-3">
        {Icon ? (
          <div
            className={cn(
              "grid size-8 shrink-0 place-items-center rounded-lg",
              isError
                ? "bg-rose-300/15 text-rose-100"
                : "bg-cyan-300/10 text-cyan-100/80",
            )}
          >
            <Icon aria-hidden="true" size={16} />
          </div>
        ) : null}
        <div className="min-w-0 flex-1" role={isError ? "alert" : "status"}>
          <div
            className={cn(
              "font-display text-sm font-medium leading-snug",
              isError ? "text-rose-50" : "text-dashboard-text",
            )}
          >
            {title}
            {detail ? " " : null}
          </div>
          {detail ? (
            <div
              className={cn(
                "mt-0.5 truncate font-mono text-xs",
                isError ? "text-rose-100/70" : "text-dashboard-text-muted",
              )}
            >
              {detail}
            </div>
          ) : null}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

/** Render an action that fits the dashboard notice surface. */
export function NoticeAction({
  className,
  tone = "default",
  type = "button",
  ...props
}: NoticeActionProps) {
  const isError = tone === "error";
  return (
    <button
      {...props}
      className={cn(
        "shrink-0 cursor-pointer px-3 py-1.5 text-xs transition focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-40",
        isError ? "focus:ring-rose-300/40" : "focus:ring-cyan-300/35",
        isError
          ? "rounded-lg bg-rose-200/15 font-display font-medium text-rose-50 hover:bg-rose-200/25"
          : "rounded-lg bg-cyan-200/10 font-display font-medium text-cyan-100 hover:bg-cyan-200/20",
        className,
      )}
      type={type}
    />
  );
}
