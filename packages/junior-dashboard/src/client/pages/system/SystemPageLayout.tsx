import type { ReactNode } from "react";

import { PageLayout } from "../../components/layout/PageLayout";
import { SystemNavigation } from "./SystemNavigation";
import type { SystemPlugin } from "./SystemPlugins";

/** Place one System page beside the shared route-backed navigation. */
export function SystemPageLayout(props: {
  children: ReactNode;
  plugins?: SystemPlugin[];
  reportingPlugins?: SystemPlugin[];
}) {
  return (
    <PageLayout>
      <div className="grid min-w-0 items-start gap-4 sm:gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <SystemNavigation
          plugins={props.plugins}
          reportingPlugins={props.reportingPlugins}
        />
        <div className="grid min-w-0 gap-4 sm:gap-6">{props.children}</div>
      </div>
    </PageLayout>
  );
}
