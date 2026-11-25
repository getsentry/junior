import assert from "node:assert/strict";
import test from "node:test";
import {
  budgetedPaths,
  checkNavRequestBudgets,
  navRoutes,
} from "./check-nav-request-budgets.mjs";

test("reads the routes of the pages that the primary nav lists", () => {
  assert.deepEqual(
    navRoutes(
      `
        const LEAD_NAV_KEY = "lead";
        return [navItem(LEAD_NAV_KEY), navItem("inbox"), navItem("system")];
      `,
      `const SYSTEM = "/system";
export const NAV_PAGES = {
  lead: { access: "account", label: "Lead", to: "/" },
  inbox: { label: "Inbox", to: inboxViewPath("inbox") },
  system: {
    label: "System",
    to: SYSTEM,
  },
  people: { area: SYSTEM, label: "People", to: \`\${SYSTEM}/people\` },
};`,
    ),
    { errors: [], routes: ["/", "/inbox", "/system"] },
  );
});

test("reports a nav page whose route it cannot read", () => {
  assert.deepEqual(
    navRoutes(
      `return [navItem("code")];`,
      `export const NAV_PAGES = {
  code: { label: "Code", to: codePath() },
};`,
    ).errors,
    [
      "code: cannot read its route in packages/junior-dashboard/src/client/navPages.ts",
    ],
  );
});

test("reads only the paths that a spec loads inside a budget", () => {
  assert.deepEqual(
    budgetedPaths(`
      await page.goto(\`\${dashboard.baseURL}/code\`);
      await expectRequestBudget(
        page,
        async () => {
          await page.goto(dashboard.baseURL);
        },
        { requests: 7, serialRounds: 1 },
      );
      await expectRequestBudget(page, async () => {
        await page.goto(\`\${dashboard.baseURL}/inbox?item=\${id}\`, {
          waitUntil: "networkidle",
        });
      }, { requests: 9, serialRounds: 2 });
    `),
    ["/", "/inbox"],
  );
});

test("accepts a budgeted route and a route with a reason", () => {
  assert.deepEqual(
    checkNavRequestBudgets(["/", "/inbox", "/code"], ["/", "/inbox/item-1"], {
      "/code": "Its spec checks the change list.",
    }),
    [],
  );
});

test("reports a nav route without a budget", () => {
  const [error, ...rest] = checkNavRequestBudgets(["/", "/code"], ["/"], {});
  assert.deepEqual(rest, []);
  assert.match(error, /^\/code: primary nav route has no request budget\. /);
  assert.match(error, /expectRequestBudget/);
});

test("does not count a page under another route as the root route", () => {
  assert.equal(
    checkNavRequestBudgets(["/"], ["/conversations/1"], {}).length,
    1,
  );
});

test("reports stale and invalid exceptions", () => {
  assert.deepEqual(
    checkNavRequestBudgets(["/", "/code", "/system"], ["/", "/system"], {
      "/code": "",
      "/people": "Not in the nav.",
      "/system": "Its spec rewrites the stats response.",
    }),
    [
      "/code: request budget exception needs a reason",
      "/people: is not a primary nav route; remove its exception",
      "/system: now has a request budget; remove its exception",
    ],
  );
});
