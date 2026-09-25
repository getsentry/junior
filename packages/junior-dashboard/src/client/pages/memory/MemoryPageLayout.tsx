import type { ReactNode } from "react";
import { useLocation } from "react-router";

import { PageContentSkeleton } from "../../components/PageContentSkeleton";
import { PageHeader } from "../../components/layout/PageHeader";
import { PageLayout } from "../../components/layout/PageLayout";
import { SecondaryNavigation } from "../../components/layout/SecondaryNavigation";

const MEMORY_BASE_PATH = "/memories";
const MEMORY_LIBRARY_PATH = `${MEMORY_BASE_PATH}/library`;
const RESERVED_MEMORY_SEGMENTS = new Set(["library"]);

function isMemoriesLibraryPath(pathname: string): boolean {
  if (
    pathname === MEMORY_LIBRARY_PATH ||
    pathname.startsWith(`${MEMORY_LIBRARY_PATH}/`)
  ) {
    return true;
  }
  const match = pathname.match(/^\/memories\/([^/]+)$/);
  return Boolean(match?.[1] && !RESERVED_MEMORY_SEGMENTS.has(match[1]));
}

/** Place the shared secondary navigation above one Memories page. */
export function MemoryPageLayout(props: { children: ReactNode }) {
  return (
    <>
      <SecondaryNavigation
        ariaLabel="Memory navigation"
        items={[
          { end: true, label: "Overview", to: MEMORY_BASE_PATH },
          {
            isActive: isMemoriesLibraryPath,
            label: "Memories",
            to: MEMORY_LIBRARY_PATH,
          },
        ]}
      />
      <PageLayout className="gap-6 sm:gap-8">{props.children}</PageLayout>
    </>
  );
}

/** Keep Memories chrome stable while shell or page data is still loading. */
export function MemoryRouteLoading(props: {
  description?: string;
  label: string;
  title?: string;
}) {
  const location = useLocation();
  const overview = location.pathname === MEMORY_BASE_PATH;
  return (
    <MemoryPageLayout>
      <PageHeader
        description={
          props.description ??
          "Personal and public memories Junior can use across conversations."
        }
        title={props.title ?? "Memories"}
      />
      <PageContentSkeleton
        label={props.label}
        variant={overview ? "overview" : "library"}
      />
    </MemoryPageLayout>
  );
}
