import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquireBodyScrollLock,
  releaseBodyScrollLock,
  resetBodyScrollLockForTests,
} from "../src/client/bodyScrollLock";

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
  beforeEach(() => {
    resetBodyScrollLockForTests();
  });

  afterEach(() => {
    resetBodyScrollLockForTests();
    vi.unstubAllGlobals();
  });

  it("locks html and body overflow once and restores the original styles", () => {
    const { bodyStyle, htmlStyle } = installDocumentMock({
      bodyOverflow: "auto",
      bodyOverscroll: "auto",
      htmlOverflow: "scroll",
      htmlOverscroll: "contain",
    });

    acquireBodyScrollLock();
    expect(bodyStyle.overflow).toBe("hidden");
    expect(htmlStyle.overflow).toBe("hidden");
    expect(bodyStyle.overscrollBehavior).toBe("none");
    expect(htmlStyle.overscrollBehavior).toBe("none");

    releaseBodyScrollLock();
    expect(bodyStyle.overflow).toBe("auto");
    expect(htmlStyle.overflow).toBe("scroll");
    expect(bodyStyle.overscrollBehavior).toBe("auto");
    expect(htmlStyle.overscrollBehavior).toBe("contain");
  });

  it("keeps the page locked until nested holders all release", () => {
    const { bodyStyle } = installDocumentMock();

    // Workspace shell + open mobile nav both hold the lock.
    acquireBodyScrollLock();
    acquireBodyScrollLock();
    expect(bodyStyle.overflow).toBe("hidden");

    // Leaving the workspace first must not unlock under the still-open nav.
    releaseBodyScrollLock();
    expect(bodyStyle.overflow).toBe("hidden");

    releaseBodyScrollLock();
    expect(bodyStyle.overflow).toBe("");
  });

  it("does not restore a nested capture of hidden after coordinated release", () => {
    const { bodyStyle } = installDocumentMock();

    // Shell locks first (as on mobile workspace).
    acquireBodyScrollLock();
    // Nav sheet acquires while already locked — must not snapshot "hidden".
    acquireBodyScrollLock();

    // Navigate away: shell cleanup, then nav cleanup on pathname change.
    releaseBodyScrollLock();
    releaseBodyScrollLock();

    expect(bodyStyle.overflow).toBe("");
  });
});
