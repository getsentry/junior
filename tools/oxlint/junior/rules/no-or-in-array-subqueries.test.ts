import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { noOrInArraySubqueriesRule } from "./no-or-in-array-subqueries.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const noOrInArraySubqueries = [{ messageId: "noOrInArraySubqueries" }];

new RuleTester().run("no-or-in-array-subqueries", noOrInArraySubqueriesRule, {
  valid: [
    "or(inArray(t.a, ids), inArray(t.b, ids));",
    "or(inArray(t.a, [x, y]), inArray(t.b, [...ids]));",
    "const ids = await db.select({ id: t.id }).from(t); or(inArray(t.a, ids), inArray(t.b, ids));",
    "const roots = db.select({ id: t.id }).from(t); or(inArray(t.a, roots), eq(t.b, x));",
    "function f(roots) { return or(inArray(t.a, roots), inArray(t.b, roots)); }",
    "or(inArray(t.a, rootsOf(x)), inArray(t.b, rootsOf(x)));",
    "const roots = db.select({ id: t.id }).from(t); and(inArray(t.a, roots), inArray(t.b, roots));",
    "const roots = db.select({ id: t.id }).from(t); or(sql`${t.a} = any(array(${roots}))`, sql`${t.b} = any(array(${roots}))`);",
  ],
  invalid: [
    {
      code: "const roots = db.select({ id: t.id }).from(t).where(eq(t.x, x)); or(inArray(t.a, roots), inArray(t.b, roots));",
      errors: noOrInArraySubqueries,
    },
    {
      code: "or(inArray(t.a, db.select({ id: t.id }).from(t)), inArray(t.b, getDb().selectDistinct({ id: t.id }).from(t)));",
      errors: noOrInArraySubqueries,
    },
    {
      code: "const base = db.select({ id: t.id }).from(t); const roots = flag ? base.where(eq(t.x, x)) : base.innerJoin(u, eq(u.id, t.id)); or(and(isNull(t.p), inArray(t.a, roots)), inArray(t.p, roots));",
      errors: noOrInArraySubqueries,
    },
  ],
});
