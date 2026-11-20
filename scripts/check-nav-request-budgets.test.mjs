import assert from "node:assert/strict";
import test from "node:test";
import {
  budgetedPaths,
  checkNavRequestBudgets,
  navRoutes,
} from "./check-nav-request-budgets.mjs";

test("reads the static routes of a primary nav", () => {
  assert.deepEqual(
    navRoutes(`
      const CODE = { key: "code", label: "Code", to: "/code" };
      return [{ key: "inbox", label: "Inbox", to: "/" }, CODE];
    `),
    ["/code", "/"],
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
