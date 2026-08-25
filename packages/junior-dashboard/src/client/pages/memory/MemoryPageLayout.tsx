import type { ReactNode } from "react";
import { useLocation } from "react-router";

import { PageContentSkeleton } from "../../components/PageContentSkeleton";
import { PageHeader } from "../../components/layout/PageHeader";
import { PageLayout } from "../../components/layout/PageLayout";
import { SecondaryNavigation } from "../../components/layout/SecondaryNavigation";
import { pathWithSearch } from "../../searchParams";

const MEMORY_BASE_PATH = "/memories";
const MEMORY_LIBRARY_PATH = `${MEMORY_BASE_PATH}/library`;

/** Place the shared secondary navigation above one Memories page. */
export function MemoryPageLayout(props: {
  children: ReactNode;
  libraryHref?: string;
}) {
  return (
    <>
      <SecondaryNavigation
        ariaLabel="Memory navigation"
        items={[
          { end: true, label: "Overview", to: MEMORY_BASE_PATH },
          {
            label: "Memories",
            to: props.libraryHref ?? MEMORY_LIBRARY_PATH,
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
    <MemoryPageLayout
      libraryHref={pathWithSearch(MEMORY_LIBRARY_PATH, location.search)}
    >
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
