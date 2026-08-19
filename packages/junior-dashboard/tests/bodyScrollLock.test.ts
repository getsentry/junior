import { afterEach, describe, expect, it, vi } from "vitest";

import { createBodyScrollLock } from "../src/client/bodyScrollLock";

type StyleBag = {
  height: string;
  left: string;
  overflow: string;
  overscrollBehavior: string;
  position: string;
  right: string;
  top: string;
  width: string;
};

function installDocumentMock(
  initial: {
    bodyOverflow?: string;
    bodyOverscroll?: string;
    htmlOverflow?: string;
    htmlOverscroll?: string;
    scrollX?: number;
    scrollY?: number;
  } = {},
) {
  const htmlStyle: StyleBag = {
    height: "",
    left: "",
    overflow: initial.htmlOverflow ?? "",
    overscrollBehavior: initial.htmlOverscroll ?? "",
    position: "",
    right: "",
    top: "",
    width: "",
  };
  const bodyStyle: StyleBag = {
    height: "",
    left: "",
    overflow: initial.bodyOverflow ?? "",
    overscrollBehavior: initial.bodyOverscroll ?? "",
    position: "",
    right: "",
    top: "",
    width: "",
  };
  const scrollTo = vi.fn();

  vi.stubGlobal("document", {
    body: { style: bodyStyle },
    documentElement: { style: htmlStyle },
  });
  vi.stubGlobal("window", {
    pageXOffset: initial.scrollX ?? 0,
    pageYOffset: initial.scrollY ?? 0,
    scrollTo,
    scrollX: initial.scrollX ?? 0,
    scrollY: initial.scrollY ?? 0,
  });

  return { bodyStyle, htmlStyle, scrollTo };
}

describe("bodyScrollLock", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("locks html and body overflow once and restores the original styles", () => {
    const lock = createBodyScrollLock();
    const { bodyStyle, htmlStyle, scrollTo } = installDocumentMock({
      bodyOverflow: "auto",
      bodyOverscroll: "auto",
      htmlOverflow: "scroll",
      htmlOverscroll: "contain",
      scrollX: 12,
      scrollY: 48,
    });

    lock.acquire();
    expect(bodyStyle.overflow).toBe("hidden");
    expect(htmlStyle.overflow).toBe("hidden");
    expect(bodyStyle.overscrollBehavior).toBe("none");
    expect(htmlStyle.overscrollBehavior).toBe("none");
    expect(bodyStyle.position).toBe("fixed");
    expect(bodyStyle.top).toBe("-48px");
    expect(bodyStyle.left).toBe("-12px");
    expect(bodyStyle.width).toBe("100%");
    expect(htmlStyle.height).toBe("100%");

    lock.release();
    expect(bodyStyle.overflow).toBe("auto");
    expect(htmlStyle.overflow).toBe("scroll");
    expect(bodyStyle.overscrollBehavior).toBe("auto");
    expect(htmlStyle.overscrollBehavior).toBe("contain");
    expect(bodyStyle.position).toBe("");
    expect(bodyStyle.top).toBe("");
    expect(scrollTo).toHaveBeenCalledWith(12, 48);
  });

  it("keeps the page locked until nested holders all release", () => {
    const lock = createBodyScrollLock();
    const { bodyStyle } = installDocumentMock();

    // Workspace shell + open mobile nav both hold the lock.
    lock.acquire();
    lock.acquire();
    expect(bodyStyle.overflow).toBe("hidden");
    expect(bodyStyle.position).toBe("fixed");

    // Leaving the workspace first must not unlock under the still-open nav.
    lock.release();
    expect(bodyStyle.overflow).toBe("hidden");
    expect(bodyStyle.position).toBe("fixed");

    lock.release();
    expect(bodyStyle.overflow).toBe("");
    expect(bodyStyle.position).toBe("");
  });

  it("does not restore a nested capture of hidden after coordinated release", () => {
    const lock = createBodyScrollLock();
    const { bodyStyle } = installDocumentMock();

    // Shell locks first (as on mobile workspace).
    lock.acquire();
    // Nav sheet acquires while already locked — must not snapshot "hidden".
    lock.acquire();

    // Navigate away: shell cleanup, then nav cleanup on pathname change.
    lock.release();
    lock.release();

    expect(bodyStyle.overflow).toBe("");
    expect(bodyStyle.position).toBe("");
  });
});
