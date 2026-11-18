/**
 * Primary nav routes that no dashboard e2e spec loads under
 * `expectRequestBudget` yet.
 *
 * Every entry needs a reason. Remove the entry when a spec budgets the route.
 * Do not add entries: a new nav route gets its budget with the page.
 */
export const navRequestBudgetExceptions = {
  "/automations":
    "Its specs check list filters, runs, and the editor, not a first page load.",
  "/code": "Its spec checks the change list, not a first page load.",
  "/system":
    "Its spec rewrites the stats response, so it does not measure a first page load.",
};
