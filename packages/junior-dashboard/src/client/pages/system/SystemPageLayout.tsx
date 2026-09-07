import type { ReactNode } from "react";

import { PageRouteLoading } from "../../components/PageRouteLoading";
import type { PageContentSkeletonVariant } from "../../components/PageContentSkeleton";
import { PageLayout } from "../../components/layout/PageLayout";
import { SystemNavigation } from "./SystemNavigation";

/** Place the shared secondary navigation above one System page. */
export function SystemPageLayout(props: { children: ReactNode }) {
  return (
    <>
      <SystemNavigation />
      <PageLayout>{props.children}</PageLayout>
    </>
  );
}

/** Keep System navigation and expected page content stable during loading. */
export function SystemRouteLoading(props: {
  description: string;
  label: string;
  title: string;
  variant?: PageContentSkeletonVariant;
}) {
  return (
    <>
      <SystemNavigation />
      <PageRouteLoading {...props} />
    </>
  );
}
