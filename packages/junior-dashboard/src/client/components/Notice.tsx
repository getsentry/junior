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
  emphasis?: "default" | "primary";
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
  return (
    <div
      className={cn(
        "overflow-hidden border bg-[#111719] shadow-[0_12px_32px_rgba(0,0,0,0.45)]",
        tone === "default"
          ? "rounded-xl border-cyan-200/20 bg-[linear-gradient(135deg,rgba(25,42,45,0.98),rgba(15,21,23,0.98))] shadow-[0_16px_40px_rgba(0,0,0,0.5)] backdrop-blur-md"
          : "rounded-lg border-rose-300/25",
      )}
    >
      <div
        className={cn(
          "flex min-w-0 items-center gap-3 px-3",
          tone === "default" ? "py-3" : "py-2.5",
        )}
      >
        {Icon ? (
          <div
            className={cn(
              "grid size-8 shrink-0 place-items-center rounded-lg",
              tone === "default"
                ? "bg-cyan-300/10 text-cyan-100/80"
                : "bg-rose-300/10 text-rose-200/80",
            )}
          >
            <Icon aria-hidden="true" size={16} />
          </div>
        ) : null}
        <div
          className="min-w-0 flex-1"
          role={tone === "error" ? "alert" : "status"}
        >
          <div
            className={
              tone === "default"
                ? "font-display text-sm font-medium text-dashboard-text"
                : "font-mono text-xs text-rose-200/80"
            }
          >
            {title}
          </div>
          {detail ? (
            <div className="mt-0.5 truncate font-mono text-xs text-dashboard-text-muted">
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
  emphasis = "default",
  type = "button",
  ...props
}: NoticeActionProps) {
  return (
    <button
      {...props}
      className={cn(
        "shrink-0 cursor-pointer px-3 py-1.5 text-xs transition focus:outline-none focus:ring-2 focus:ring-cyan-300/35 disabled:cursor-not-allowed disabled:opacity-40",
        emphasis === "primary"
          ? "rounded-lg bg-cyan-200/10 font-display font-medium text-cyan-100 hover:bg-cyan-200/20"
          : "rounded border border-white/15 font-mono text-dashboard-text-muted hover:border-white/30 hover:text-dashboard-text",
        className,
      )}
      type={type}
    />
  );
}
