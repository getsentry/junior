import fs from "node:fs";
import path from "node:path";
import { navRequestBudgetExceptions } from "./nav-request-budget-exceptions.mjs";

const DASHBOARD = "packages/junior-dashboard";
// The classic and the Inbox shells each build their own primary nav.
const NAV_FILES = [
  `${DASHBOARD}/src/client/primaryNav.ts`,
  `${DASHBOARD}/src/client/shell/primaryNav.ts`,
];
const E2E_DIRECTORY = `${DASHBOARD}/e2e`;
const BUDGET_CALL = "expectRequestBudget(";

// Agents read this text as the fix instruction.
const GUIDANCE =
  "Load the page in a dashboard e2e spec inside `expectRequestBudget` from " +
  `${E2E_DIRECTORY}/request-budget.ts, with the budget set to the measured ` +
  "value. See policies/performance.md.";

/** Return the static routes that a primary nav source links to. */
export function navRoutes(source) {
  return [...source.matchAll(/\bto:\s*"(\/[^"]*)"/g)].map((match) => match[1]);
}

/** Return the text of each `expectRequestBudget(...)` call in a spec. */
function budgetCalls(source) {
  const calls = [];
  for (
    let start = source.indexOf(BUDGET_CALL);
    start !== -1;
    start = source.indexOf(BUDGET_CALL, start + 1)
  ) {
    let depth = 0;
    let end = start + BUDGET_CALL.length - 1;
    for (; end < source.length; end += 1) {
      if (source[end] === "(") depth += 1;
      if (source[end] === ")" && --depth === 0) break;
    }
    calls.push(source.slice(start, end + 1));
  }
  return calls;
}

/**
 * Return the paths that a spec loads inside `expectRequestBudget`, such as
 * `/` for `page.goto(dashboard.baseURL)` and `/inbox` for
 * ``page.goto(`${dashboard.baseURL}/inbox`)``.
 */
export function budgetedPaths(source) {
  return budgetCalls(source).flatMap((call) =>
    [...call.matchAll(/\.goto\(\s*([^,)]+)/g)].map((match) => {
      const target = match[1]
        .trim()
        .replace(/^[`"']/, "")
        .replace(/^(?:\$\{)?dashboard\.baseURL\}?/, "");
      return target.match(/^\/[^?#`"'$]*/)?.[0] ?? "/";
    }),
  );
}

/** Say whether a loaded path is the page of a nav route. */
function loadsRoute(loadedPath, route) {
  return route === "/"
    ? loadedPath === "/"
    : loadedPath === route || loadedPath.startsWith(`${route}/`);
}

/** Report nav routes without a request budget, and stale or invalid exceptions. */
export function checkNavRequestBudgets(routes, paths, exceptions) {
  const errors = [];
  const budgeted = (route) => paths.some((loaded) => loadsRoute(loaded, route));
  for (const [route, reason] of Object.entries(exceptions)) {
    if (typeof reason !== "string" || !reason.trim()) {
      errors.push(`${route}: request budget exception needs a reason`);
    } else if (!routes.includes(route)) {
      errors.push(`${route}: is not a primary nav route; remove its exception`);
    } else if (budgeted(route)) {
      errors.push(`${route}: now has a request budget; remove its exception`);
    }
  }
  for (const route of new Set(routes)) {
    if (budgeted(route) || route in exceptions) continue;
    errors.push(
      `${route}: primary nav route has no request budget. ${GUIDANCE}`,
    );
  }
  return errors;
}

/** Check that each primary nav route has a request budget or an exception. */
export function run({ root, files }) {
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  const routes = NAV_FILES.flatMap((file) => navRoutes(read(file)));
  const paths = files
    .filter(
      (file) =>
        file.startsWith(`${E2E_DIRECTORY}/`) && file.endsWith(".spec.ts"),
    )
    .flatMap((file) => budgetedPaths(read(file)));
  return checkNavRequestBudgets(routes, paths, navRequestBudgetExceptions);
}
