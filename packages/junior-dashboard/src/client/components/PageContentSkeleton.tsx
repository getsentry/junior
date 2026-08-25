import { Card } from "./layout/Card";
import { cn } from "../styles";

type PageContentSkeletonVariant =
  | "stats"
  | "overview"
  | "list"
  | "library"
  | "panel";

/** Reserve page-body space while route data loads so chrome stays put. */
export function PageContentSkeleton(props: {
  className?: string;
  label: string;
  variant?: PageContentSkeletonVariant;
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
              <SkeletonCard
                className="min-h-[7.5rem] p-4 sm:min-h-32 sm:p-5"
                key={index}
              />
            ))}
          </div>
          <SkeletonCard className="min-h-[17rem]" />
        </>
      ) : null}
      {variant === "overview" ? (
        <>
          <div className="grid gap-4 xl:grid-cols-2">
            <SkeletonCard className="min-h-[17rem]" />
            <SkeletonCard className="min-h-[17rem]" />
          </div>
          <div className="h-24 animate-pulse border-y border-white/[0.06] bg-white/[0.02]">
            <span aria-hidden="true" />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <SkeletonCard className="min-h-56" />
            <SkeletonCard className="min-h-56" />
          </div>
        </>
      ) : null}
      {variant === "list" ? (
        <>
          <SkeletonCard className="min-h-20 p-4" />
          <div className="h-10 animate-pulse border-b border-white/[0.07]">
            <span aria-hidden="true" />
          </div>
          <SkeletonCard className="min-h-80" />
        </>
      ) : null}
      {variant === "library" ? (
        <>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="h-7 w-56 animate-pulse rounded bg-white/[0.04]">
              <span aria-hidden="true" />
            </div>
            <div className="h-10 w-full max-w-md animate-pulse rounded-lg border border-white/[0.06] bg-white/[0.02] sm:w-72">
              <span aria-hidden="true" />
            </div>
          </div>
          <div
            aria-hidden="true"
            className="grid min-w-0 grid-cols-3 gap-1 border-b border-white/[0.06] sm:flex"
          >
            {["All", "Private", "Public"].map((label) => (
              <div
                className="flex items-center justify-between gap-2 px-3 py-2.5 sm:justify-start"
                key={label}
              >
                <span className="h-3 w-12 animate-pulse rounded bg-white/[0.05]" />
                <span className="h-5 w-8 animate-pulse rounded-sm border border-white/[0.07] bg-white/[0.025]" />
              </div>
            ))}
          </div>
          <SkeletonCard className="min-h-80" />
        </>
      ) : null}
      {variant === "panel" ? <SkeletonCard className="min-h-64" /> : null}
    </div>
  );
}

function SkeletonCard(props: { className?: string }) {
  return (
    <Card className={cn("animate-pulse", props.className)}>
      <span aria-hidden="true" />
    </Card>
  );
}
