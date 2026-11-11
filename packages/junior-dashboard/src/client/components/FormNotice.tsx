import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { Alert, AlertTitle } from "./ui/alert";

/** Keep form recovery text and actions visible without truncation. */
export function FormNotice(props: {
  title: string;
  children?: ReactNode;
  tone?: "error" | "warning";
}) {
  const error = props.tone === "error";
  return (
    // The children hold links and buttons, so they skip AlertDescription and
    // its link styles.
    <Alert
      layout="notice"
      role={error ? "alert" : "status"}
      variant={error ? "destructive" : "warning"}
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
