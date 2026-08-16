// Nested drawers, the mobile nav sheet, and the mobile workspace shell all need
// document scroll locked. Share one refcount so independent save/restore paths
// cannot leave body.overflow stuck on "hidden" after navigation.

type DocumentScrollStyles = {
  bodyOverflow: string;
  bodyOverscroll: string;
  htmlOverflow: string;
  htmlOverscroll: string;
};

let lockCount = 0;
let previousStyles: DocumentScrollStyles | undefined;

/** Lock document scroll. Nested callers share one restore. */
export function acquireBodyScrollLock(): void {
  if (typeof document === "undefined") return;

  if (lockCount === 0) {
    const html = document.documentElement;
    const body = document.body;
    previousStyles = {
      bodyOverflow: body.style.overflow,
      bodyOverscroll: body.style.overscrollBehavior,
      htmlOverflow: html.style.overflow,
      htmlOverscroll: html.style.overscrollBehavior,
    };
    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    html.style.overscrollBehavior = "none";
    body.style.overscrollBehavior = "none";
  }
  lockCount += 1;
}

/** Release one document scroll lock. Restores styles when the last holder exits. */
export function releaseBodyScrollLock(): void {
  if (typeof document === "undefined" || lockCount === 0) return;

  lockCount = Math.max(0, lockCount - 1);
  if (lockCount > 0 || previousStyles === undefined) return;

  const html = document.documentElement;
  const body = document.body;
  html.style.overflow = previousStyles.htmlOverflow;
  body.style.overflow = previousStyles.bodyOverflow;
  html.style.overscrollBehavior = previousStyles.htmlOverscroll;
  body.style.overscrollBehavior = previousStyles.bodyOverscroll;
  previousStyles = undefined;
}

/** Test-only reset so unit cases do not leak lock count across files. */
export function resetBodyScrollLockForTests(): void {
  lockCount = 0;
  previousStyles = undefined;
}
