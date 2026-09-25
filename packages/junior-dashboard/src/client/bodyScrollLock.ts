// Nested drawers, the mobile nav sheet, and the mobile workspace shell all need
// document scroll locked. Share one refcount so independent save/restore paths
// cannot leave body.overflow stuck on "hidden" after navigation.
//
// iOS Safari can still pan the document under overflow:hidden. Pin html/body to
// the layout viewport while locked so the fixed conversation shell cannot drift.

type DocumentScrollStyles = {
  bodyHeight: string;
  bodyLeft: string;
  bodyOverflow: string;
  bodyOverscroll: string;
  bodyPosition: string;
  bodyRight: string;
  bodyTop: string;
  bodyWidth: string;
  htmlHeight: string;
  htmlOverflow: string;
  htmlOverscroll: string;
  scrollX: number;
  scrollY: number;
};

export type BodyScrollLock = {
  acquire(): void;
  release(): void;
};

/** Build an independent document scroll lock. Production uses the shared default. */
export function createBodyScrollLock(): BodyScrollLock {
  let lockCount = 0;
  let previousStyles: DocumentScrollStyles | undefined;

  return {
    acquire() {
      if (typeof document === "undefined") return;

      if (lockCount === 0) {
        const html = document.documentElement;
        const body = document.body;
        const scrollX =
          typeof window === "undefined"
            ? 0
            : window.scrollX || window.pageXOffset || 0;
        const scrollY =
          typeof window === "undefined"
            ? 0
            : window.scrollY || window.pageYOffset || 0;
        previousStyles = {
          bodyHeight: body.style.height,
          bodyLeft: body.style.left,
          bodyOverflow: body.style.overflow,
          bodyOverscroll: body.style.overscrollBehavior,
          bodyPosition: body.style.position,
          bodyRight: body.style.right,
          bodyTop: body.style.top,
          bodyWidth: body.style.width,
          htmlHeight: html.style.height,
          htmlOverflow: html.style.overflow,
          htmlOverscroll: html.style.overscrollBehavior,
          scrollX,
          scrollY,
        };
        html.style.overflow = "hidden";
        html.style.overscrollBehavior = "none";
        html.style.height = "100%";
        body.style.overflow = "hidden";
        body.style.overscrollBehavior = "none";
        body.style.position = "fixed";
        body.style.top = `-${scrollY}px`;
        body.style.left = `-${scrollX}px`;
        body.style.right = "0";
        body.style.width = "100%";
        body.style.height = "100%";
      }
      lockCount += 1;
    },
    release() {
      if (typeof document === "undefined" || lockCount === 0) return;

      lockCount = Math.max(0, lockCount - 1);
      if (lockCount > 0 || previousStyles === undefined) return;

      const html = document.documentElement;
      const body = document.body;
      html.style.overflow = previousStyles.htmlOverflow;
      html.style.overscrollBehavior = previousStyles.htmlOverscroll;
      html.style.height = previousStyles.htmlHeight;
      body.style.overflow = previousStyles.bodyOverflow;
      body.style.overscrollBehavior = previousStyles.bodyOverscroll;
      body.style.position = previousStyles.bodyPosition;
      body.style.top = previousStyles.bodyTop;
      body.style.left = previousStyles.bodyLeft;
      body.style.right = previousStyles.bodyRight;
      body.style.width = previousStyles.bodyWidth;
      body.style.height = previousStyles.bodyHeight;
      const { scrollX, scrollY } = previousStyles;
      previousStyles = undefined;
      if (typeof window !== "undefined") {
        window.scrollTo(scrollX, scrollY);
      }
    },
  };
}

const sharedBodyScrollLock = createBodyScrollLock();

/** Lock document scroll. Nested callers share one restore. */
export function acquireBodyScrollLock(): void {
  sharedBodyScrollLock.acquire();
}

/** Release one document scroll lock. Restores styles when the last holder exits. */
export function releaseBodyScrollLock(): void {
  sharedBodyScrollLock.release();
}
