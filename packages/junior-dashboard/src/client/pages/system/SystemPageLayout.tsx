import type { ReactNode } from "react";

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
