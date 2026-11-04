import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { cn } from "../styles";
import { Alert, AlertTitle } from "./ui/alert";

/** Keep form recovery text and actions visible without truncation. */
export function FormNotice(props: {
  title: string;
  children?: ReactNode;
  tone?: "error" | "warning";
}) {
  const error = props.tone === "error";
  return (
    // Flex, not the Alert grid: the text column keeps its content width and
    // its margin collapses with the first paragraph. The children hold links
    // and buttons, so they skip AlertDescription and its link styles.
    <Alert
      role={error ? "alert" : "status"}
      className={cn(
        "flex min-w-0 rounded-md p-4 has-[>svg]:gap-x-3",
        error
          ? "border-rose-300/25 bg-rose-300/5 *:[svg]:text-rose-300"
          : "border-amber-300/25 bg-amber-300/5 *:[svg]:text-amber-300",
      )}
    >
      <TriangleAlert aria-hidden className="size-4.5 shrink-0" />
      <div className="min-w-0">
        <AlertTitle>{props.title}</AlertTitle>
        {props.children ? (
          <div className="mt-1 text-sm leading-relaxed text-dashboard-text-muted">
            {props.children}
          </div>
        ) : null}
      </div>
    </Alert>
  );
}
