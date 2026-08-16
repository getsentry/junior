import { afterEach, describe, expect, it, vi } from "vitest";

import { createBodyScrollLock } from "../src/client/bodyScrollLock";

type StyleBag = {
  overflow: string;
  overscrollBehavior: string;
};

function installDocumentMock(initial: {
  bodyOverflow?: string;
  bodyOverscroll?: string;
  htmlOverflow?: string;
  htmlOverscroll?: string;
} = {}) {
  const htmlStyle: StyleBag = {
    overflow: initial.htmlOverflow ?? "",
    overscrollBehavior: initial.htmlOverscroll ?? "",
  };
  const bodyStyle: StyleBag = {
    overflow: initial.bodyOverflow ?? "",
    overscrollBehavior: initial.bodyOverscroll ?? "",
  };

  vi.stubGlobal("document", {
    body: { style: bodyStyle },
    documentElement: { style: htmlStyle },
  });

  return { bodyStyle, htmlStyle };
}

describe("bodyScrollLock", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("locks html and body overflow once and restores the original styles", () => {
    const lock = createBodyScrollLock();
    const { bodyStyle, htmlStyle } = installDocumentMock({
      bodyOverflow: "auto",
      bodyOverscroll: "auto",
      htmlOverflow: "scroll",
      htmlOverscroll: "contain",
    });

    lock.acquire();
    expect(bodyStyle.overflow).toBe("hidden");
    expect(htmlStyle.overflow).toBe("hidden");
    expect(bodyStyle.overscrollBehavior).toBe("none");
    expect(htmlStyle.overscrollBehavior).toBe("none");

    lock.release();
    expect(bodyStyle.overflow).toBe("auto");
    expect(htmlStyle.overflow).toBe("scroll");
    expect(bodyStyle.overscrollBehavior).toBe("auto");
    expect(htmlStyle.overscrollBehavior).toBe("contain");
  });

  it("keeps the page locked until nested holders all release", () => {
    const lock = createBodyScrollLock();
    const { bodyStyle } = installDocumentMock();

    // Workspace shell + open mobile nav both hold the lock.
    lock.acquire();
    lock.acquire();
    expect(bodyStyle.overflow).toBe("hidden");

    // Leaving the workspace first must not unlock under the still-open nav.
    lock.release();
    expect(bodyStyle.overflow).toBe("hidden");

    lock.release();
    expect(bodyStyle.overflow).toBe("");
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
  });
});
