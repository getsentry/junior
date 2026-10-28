import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { cn } from "../styles";

/** Keep form recovery text and actions visible without truncation. */
export function FormNotice(props: {
  title: string;
  children?: ReactNode;
  tone?: "error" | "warning";
}) {
  const error = props.tone === "error";
  return (
    <div
      role={error ? "alert" : "status"}
      className={cn(
        "flex min-w-0 gap-3 rounded-md border p-4",
        error
          ? "border-rose-300/25 bg-rose-300/5"
          : "border-amber-300/25 bg-amber-300/5",
      )}
    >
      <TriangleAlert
        aria-hidden
        size={18}
        className={cn(
          "mt-0.5 shrink-0",
          error ? "text-rose-300" : "text-amber-300",
        )}
      />
      <div className="min-w-0">
        <p className="m-0 text-sm font-medium">{props.title}</p>
        {props.children ? (
          <div className="mt-1 text-sm leading-relaxed text-dashboard-text-muted">
            {props.children}
          </div>
        ) : null}
      </div>
    </div>
  );
}
