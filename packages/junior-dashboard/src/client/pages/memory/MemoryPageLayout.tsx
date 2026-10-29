import type { ReactNode } from "react";
import { useLocation } from "react-router";

import { PageContentSkeleton } from "../../components/PageContentSkeleton";
import { PageHeader } from "../../components/layout/PageHeader";
import { PageLayout } from "../../components/layout/PageLayout";
import { SecondaryNavigation } from "../../components/layout/SecondaryNavigation";

const MEMORY_BASE_PATH = "/memories";
const MEMORY_LIBRARY_PATH = `${MEMORY_BASE_PATH}/library`;
const RESERVED_MEMORY_SEGMENTS = new Set(["library"]);

/** Identify library and memory routes that keep the list beside its details. */
export function isMemoryLibraryPath(pathname: string): boolean {
  if (
    pathname === MEMORY_LIBRARY_PATH ||
    pathname.startsWith(`${MEMORY_LIBRARY_PATH}/`)
  ) {
    return true;
  }
  const match = pathname.match(/^\/memories\/([^/]+)$/);
  return Boolean(match?.[1] && !RESERVED_MEMORY_SEGMENTS.has(match[1]));
}

/**
 * Place the shared secondary navigation above one Memories page. Library
 * children fill the remaining height and own their scroll frames.
 */
export function MemoryPageLayout(props: { children: ReactNode }) {
  const library = isMemoryLibraryPath(useLocation().pathname);
  return (
    <SecondaryNavigation
      ariaLabel="Memory navigation"
      className={
        library
          ? "grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)]"
          : undefined
      }
      items={[
        { end: true, label: "Overview", to: MEMORY_BASE_PATH },
        {
          isActive: isMemoryLibraryPath,
          label: "Memories",
          to: MEMORY_LIBRARY_PATH,
        },
      ]}
    >
      {library ? (
        <div className="min-h-0">{props.children}</div>
      ) : (
        <PageLayout className="gap-6 sm:gap-8">{props.children}</PageLayout>
      )}
    </SecondaryNavigation>
  );
}

/** Keep Memories chrome stable while shell or page data is still loading. */
export function MemoryRouteLoading(props: {
  description?: string;
  label: string;
  title?: string;
}) {
  const library = isMemoryLibraryPath(useLocation().pathname);
  const content = (
    <>
      <PageHeader
        description={
          props.description ??
          "Personal and public memories Junior can use across conversations."
        }
        title={props.title ?? "Memories"}
      />
      <PageContentSkeleton
        label={props.label}
        variant={library ? "library" : "overview"}
      />
    </>
  );
  return (
    <MemoryPageLayout>
      {library ? (
        <div className="h-full overflow-y-auto">
          <PageLayout className="gap-6 sm:gap-8">{content}</PageLayout>
        </div>
      ) : (
        content
      )}
    </MemoryPageLayout>
  );
}
