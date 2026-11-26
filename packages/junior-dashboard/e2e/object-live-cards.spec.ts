import { desktop } from "./screenshot";
import { expect, test } from "./test";
import { mockObjectLinks } from "./mock-reports";

// The mock release Conversation saves Annotations for these pull requests,
// and its last reply links to them.
const CONVERSATION_ID = "slack:CQA456:1770021600.000600";
const PULL_TITLE = "Pin the release train to payments 4.2";
const PAGE_TITLE = "Sign in to GitHub";
// The mock web page card that the signed-out page copies.
const BLOG_URL = "https://blog.example.com/posts/release-4-2";

test("a live web page card does not replace a saved pull request card", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(desktop);
  // A viewer who cannot see the repository gets GitHub's signed-out page
  // for each pull request link.
  await page.route(
    (url) => url.pathname === "/api/objects",
    async (route) => {
      const body = await mockObjectLinks(route);
      const items: { object?: Record<string, unknown>; url: string }[] =
        body.objects;
      const blog = items.find((item) => item.url === BLOG_URL)?.object;
      for (const item of items) {
        if (item.object?.["objectType"] !== "code_change") continue;
        item.object = {
          ...blog,
          description: undefined,
          key: item.url,
          label: PAGE_TITLE,
          title: PAGE_TITLE,
          url: item.url,
        };
      }
      await route.fulfill({ json: body });
    },
  );
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(CONVERSATION_ID)}`,
  );
  // The live card of the web page comes in the same response.
  await expect(
    page.getByRole("region", { name: "Web page: What's new in Release 4.2" }),
  ).toBeVisible();
  // The message row keeps the saved pull request.
  await expect(
    page.getByRole("region", { name: `Pull request: ${PULL_TITLE}` }),
  ).toBeVisible();
  await expect(page.getByText(PAGE_TITLE)).toHaveCount(0);
});
