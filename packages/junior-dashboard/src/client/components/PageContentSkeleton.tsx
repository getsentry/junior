import { Card } from "./layout/Card";
import { cn } from "../styles";

/** Reserve page-body space while route data loads so chrome stays put. */
export function PageContentSkeleton(props: {
  className?: string;
  label: string;
  variant?: "stats" | "list" | "panel";
}) {
  const variant = props.variant ?? "panel";
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className={cn("grid gap-4", props.className)}
      role="status"
    >
      <span className="sr-only">{props.label}</span>
      {variant === "stats" ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => (
              <Card
                className="min-h-[7.5rem] animate-pulse p-4 sm:min-h-32 sm:p-5"
                key={index}
              >
                <span aria-hidden="true" />
              </Card>
            ))}
          </div>
          <Card className="min-h-[17rem] animate-pulse">
            <span aria-hidden="true" />
          </Card>
        </>
      ) : null}
      {variant === "list" ? (
        <>
          <div className="h-16 animate-pulse rounded-lg border border-white/[0.06] bg-white/[0.02]" />
          <div className="h-10 animate-pulse border-b border-white/[0.07]" />
          <Card className="min-h-80 animate-pulse">
            <span aria-hidden="true" />
          </Card>
        </>
      ) : null}
      {variant === "panel" ? (
        <Card className="min-h-64 animate-pulse">
          <span aria-hidden="true" />
        </Card>
      ) : null}
    </div>
  );
}
