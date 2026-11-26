import fs from "node:fs";
import path from "node:path";
import { navRequestBudgetExceptions } from "./nav-request-budget-exceptions.mjs";

const DASHBOARD = "packages/junior-dashboard";
const NAV_FILE = `${DASHBOARD}/src/client/shell/primaryNav.ts`;
const NAV_PAGES_FILE = `${DASHBOARD}/src/client/navPages.ts`;
// Route builders that `navPages.ts` calls, by the path that their page
// loads. The check cannot run them.
const ROUTE_BUILDERS = { inboxViewPath: "/inbox" };
const E2E_DIRECTORY = `${DASHBOARD}/e2e`;
const BUDGET_CALL = "expectRequestBudget(";

// Agents read this text as the fix instruction.
const GUIDANCE =
  "Load the page in a dashboard e2e spec inside `expectRequestBudget` from " +
  `${E2E_DIRECTORY}/request-budget.ts, with the budget set to the measured ` +
  "value. See policies/performance.md.";

/**
 * Return the routes of the `NAV_PAGES` keys that the primary nav lists with
 * `navItem(...)`, read from the `to` of each page in `navPages.ts`. A route
 * that the check cannot read is an error, so the nav cannot skip the check.
 */
export function navRoutes(navSource, navPagesSource) {
  const constant = (source, name) =>
    source.match(new RegExp(`\\bconst ${name} = "([^"]*)";`))?.[1];
  const keys = [
    ...navSource.matchAll(/\bnavItem\(\s*(?:"(\w+)"|([A-Z_]+))\s*\)/g),
  ].map((match) => match[1] ?? constant(navSource, match[2]));
  const routes = [];
  const errors = [];
  for (const key of new Set(keys)) {
    // Pages are flat objects, so a page ends at its first `},`.
    const start = navPagesSource.search(new RegExp(`^  ${key}: \\{`, "m"));
    const page =
      start === -1
        ? ""
        : navPagesSource.slice(start, navPagesSource.indexOf("},\n", start));
    const to = page.match(/\bto: ([^\n]+?),?\s*$/m)?.[1];
    const route = to && resolveRoute(navPagesSource, to, constant);
    if (route) routes.push(route);
    else errors.push(`${key}: cannot read its route in ${NAV_PAGES_FILE}`);
  }
  return { errors, routes };
}

/** Resolve a `to` expression: a string, a constant, or a route builder. */
function resolveRoute(source, expression, constant) {
  const literal = expression.match(/^"(\/[^"]*)"$/);
  if (literal) return literal[1];
  if (/^[A-Z_]+$/.test(expression)) return constant(source, expression);
  const template = expression.match(/^`\$\{([A-Z_]+)\}(\/[^`$]*)`$/);
  if (template) {
    const root = constant(source, template[1]);
    return root && root + template[2];
  }
  return ROUTE_BUILDERS[expression.match(/^(\w+)\(/)?.[1]];
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
  const { errors, routes } = navRoutes(read(NAV_FILE), read(NAV_PAGES_FILE));
  const paths = files
    .filter(
      (file) =>
        file.startsWith(`${E2E_DIRECTORY}/`) && file.endsWith(".spec.ts"),
    )
    .flatMap((file) => budgetedPaths(read(file)));
  return [
    ...errors,
    ...checkNavRequestBudgets(routes, paths, navRequestBudgetExceptions),
  ];
}
