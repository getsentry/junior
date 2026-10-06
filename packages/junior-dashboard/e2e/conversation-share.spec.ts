import { expect, test } from "./test";
import { startDashboardE2eServer } from "./harness";

const CONVERSATION_ID = "slack:CQA123:1770003600.000200";

for (const touch of [false, true]) {
  test.describe(touch ? "touch sharing" : "desktop sharing", () => {
    test.use({ hasTouch: touch });

    test("shares a canonical conversation link under a dashboard base path", async ({
      context,
      page,
    }) => {
      const dashboard = await startDashboardE2eServer({ basePath: "/ops" });
      try {
        await context.grantPermissions(["clipboard-read", "clipboard-write"], {
          origin: dashboard.baseURL,
        });
        // A tablet uses native sharing; a narrow desktop window still copies.
        await page.setViewportSize({ width: touch ? 1024 : 390, height: 900 });
        const url = `${dashboard.baseURL}/ops/conversations/${encodeURIComponent(CONVERSATION_ID)}`;
        await page.goto(`${url}?view=raw#event-0`);
        const shared: ShareData[] = [];
        await page.exposeFunction("recordShare", (data: ShareData) => {
          shared.push(data);
        });
        await page.evaluate(() => {
          Object.defineProperty(navigator, "share", {
            configurable: true,
            value: (data: ShareData) =>
              (
                window as unknown as {
                  recordShare: (data: ShareData) => Promise<void>;
                }
              ).recordShare(data),
          });
        });
        if (!touch) {
          await page.getByRole("button", { name: "Conversation menu" }).click();
        }
        await page
          .getByRole("button", { name: "Conversation details", exact: true })
          .click();
        const details = page.getByRole("dialog", {
          name: "Investigate checkout latency",
        });
        await page.evaluate(() => navigator.clipboard.writeText("unchanged"));
        const shareButton = details.getByRole("button", {
          name: "Share",
          exact: true,
        });
        await shareButton.click();
        if (touch) {
          await expect.poll(() => shared).toEqual([{ url }]);
          await expect(shareButton).toBeEnabled();
          expect(
            await page.evaluate(() => navigator.clipboard.readText()),
          ).toBe("unchanged");

          // Dismissing the native sheet is silent and does not copy the URL.
          await page.evaluate(() => {
            Object.defineProperty(navigator, "share", {
              configurable: true,
              value: () =>
                Promise.reject(new DOMException("Canceled", "AbortError")),
            });
          });
          await shareButton.click();
          await expect(shareButton).toBeEnabled();
          await expect(details.getByRole("status")).toBeEmpty();
          expect(
            await page.evaluate(() => navigator.clipboard.readText()),
          ).toBe("unchanged");

          // A real share failure offers a retry rather than silently copying.
          await page.evaluate(() => {
            Object.defineProperty(navigator, "share", {
              configurable: true,
              value: () =>
                Promise.reject(new DOMException("Blocked", "NotAllowedError")),
            });
          });
          await shareButton.click();
          await expect(
            details.getByRole("button", { name: "Share failed — retry" }),
          ).toBeEnabled();
          expect(
            await page.evaluate(() => navigator.clipboard.readText()),
          ).toBe("unchanged");

          // Mobile browsers without Web Share can still copy the link.
          await page.evaluate(() => {
            Object.defineProperty(navigator, "share", {
              configurable: true,
              value: undefined,
            });
          });
          await details
            .getByRole("button", { name: "Share failed — retry" })
            .click();
        } else {
          expect(shared).toEqual([]);
        }
        await expect(
          details.getByRole("button", { name: "Link copied" }),
        ).toBeVisible();
        const copied = await page.evaluate(() =>
          navigator.clipboard.readText(),
        );
        expect(copied).toBe(url);
        await page.goto(copied);
        await expect(
          page.getByRole("heading", { name: "Investigate checkout latency" }),
        ).toBeVisible();
      } finally {
        await dashboard.close();
      }
    });
  });
}
