import type { ReactNode } from "react";

import { PageLayout } from "../../components/layout/PageLayout";
import { SystemNavigation } from "./SystemNavigation";

/** Place the shared secondary navigation above one System page. */
export function SystemPageLayout(props: { children: ReactNode }) {
  return (
    <div className="min-w-0">
      <SystemNavigation />
      <PageLayout>{props.children}</PageLayout>
    </div>
  );
}
