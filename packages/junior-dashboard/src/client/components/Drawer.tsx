import { lazy, Suspense } from "react";

import type { DrawerProps } from "./DrawerContent";

// A drawer opens only after a click, so base-ui's drawer loads with the first
// open instead of with the page.
const DrawerContent = lazy(() =>
  import("./DrawerContent").then((module) => ({
    default: module.DrawerContent,
  })),
);

/**
 * Render a side drawer with shared modal focus and dismissal behavior.
 * A drawer opened from inside another drawer stacks in front of it.
 */
export function Drawer(props: DrawerProps) {
  return (
    <Suspense fallback={null}>
      <DrawerContent key={props.openKey} {...props} />
    </Suspense>
  );
}
