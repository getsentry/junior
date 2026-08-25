import type { ReactNode } from "react";

import { Card } from "./layout/Card";
import { cn } from "../styles";

export type PageContentSkeletonVariant =
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
      {renderSkeletonVariant(variant)}
    </div>
  );
}

function renderSkeletonVariant(variant: PageContentSkeletonVariant): ReactNode {
  switch (variant) {
    case "stats":
      return <StatsSkeleton />;
    case "overview":
      return <OverviewSkeleton />;
    case "list":
      return <ListSkeleton />;
    case "library":
      return <LibrarySkeleton />;
    case "panel":
      return <SkeletonCard className="min-h-64" />;
  }
}

/** Four stat cards above one wide chart panel. */
function StatsSkeleton() {
  return (
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
  );
}

/** Two charts, a summary strip, and two detail panels. */
function OverviewSkeleton() {
  return (
    <>
      <div className="grid gap-4 xl:grid-cols-2">
        <SkeletonCard className="min-h-[17rem]" />
        <SkeletonCard className="min-h-[17rem]" />
      </div>
      <SkeletonBone className="h-24 border-y border-dashboard-border-subtle bg-dashboard-fill-faint" />
      <div className="grid gap-4 md:grid-cols-2">
        <SkeletonCard className="min-h-56" />
        <SkeletonCard className="min-h-56" />
      </div>
    </>
  );
}

/** Filter bar, count row, and list table. */
function ListSkeleton() {
  return (
    <>
      <SkeletonCard className="min-h-20 p-4" />
      <SkeletonBone className="h-10 border-b border-dashboard-border-subtle" />
      <SkeletonCard className="min-h-80" />
    </>
  );
}

/** Library heading, search, filter tabs, and list table. */
function LibrarySkeleton() {
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <SkeletonBone className="h-7 w-56 rounded bg-dashboard-fill-soft" />
        <SkeletonBone className="h-10 w-full max-w-md rounded-lg border border-dashboard-border-subtle bg-dashboard-fill-faint sm:w-72" />
      </div>
      <div
        aria-hidden="true"
        className="grid min-w-0 grid-cols-3 gap-1 border-b border-dashboard-border-subtle sm:flex"
      >
        {Array.from({ length: 3 }, (_, index) => (
          <div
            className="flex items-center justify-between gap-2 px-3 py-2.5 sm:justify-start"
            key={index}
          >
            <SkeletonBone className="h-3 w-12 rounded bg-dashboard-fill-soft" />
            <SkeletonBone className="h-5 w-8 rounded-sm border border-dashboard-border-subtle bg-dashboard-fill-faint" />
          </div>
        ))}
      </div>
      <SkeletonCard className="min-h-80" />
    </>
  );
}

function SkeletonCard(props: { className?: string }) {
  return (
    <Card className={cn("animate-pulse", props.className)}>
      <span aria-hidden="true" />
    </Card>
  );
}

function SkeletonBone(props: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn("animate-pulse", props.className)} />
  );
}
