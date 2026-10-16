import { expect, test } from "./test";
import { screenshot } from "./screenshot";

const githubConnection = {
  connected: false,
  description: "GitHub repository and development workflow context.",
  displayName: "GitHub",
  provider: "github",
};

test("connects and disconnects a plugin account from settings", async ({
  page,
  dashboard,
}) => {
  let connected = true;
  const requests: string[] = [];
  await page.route("**/api/connections", async (route) => {
    await route.fulfill({
      json: {
        connections: [
          connected
            ? {
                ...githubConnection,
                account: {
                  label: "octocat",
                  url: "https://github.com/octocat",
                },
                connected: true,
              }
            : githubConnection,
        ],
      },
    });
  });
  await page.route("**/api/connections/github", async (route) => {
    const method = route.request().method();
    requests.push(method);
    if (method === "DELETE") {
      connected = false;
      await route.fulfill({ json: { disconnected: true } });
      return;
    }
    await route.fulfill({
      json: {
        authorizationUrl: "https://oauth.example.com/authorize?state=s",
      },
    });
  });
  // The provider page opens in a new tab, so route it on the context.
  await page.context().route("https://oauth.example.com/**", async (route) => {
    await route.fulfill({ body: "Provider authorization", status: 200 });
  });

  await page.goto(`${dashboard.baseURL}/settings/connections`);
  await expect(
    page.getByRole("heading", { name: "Connected accounts" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "octocat" })).toBeVisible();
  await screenshot(page, "settings-connections");

  await page.getByRole("button", { name: "Disconnect GitHub" }).click();
  const connectButton = page.getByRole("button", { name: "Connect GitHub" });
  await expect(connectButton).toBeVisible();

  const popupPromise = page.waitForEvent("popup");
  await connectButton.click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL("https://oauth.example.com/authorize?state=s");
  expect(requests).toEqual(["DELETE", "POST"]);
});
