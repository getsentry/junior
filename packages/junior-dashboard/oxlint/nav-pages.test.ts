import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { listedPagePathRule } from "./nav-pages.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const literalPath = [{ messageId: "literalPath" }];

new RuleTester({
  languageOptions: { parserOptions: { lang: "tsx" } },
}).run("listed-page-path", listedPagePathRule, {
  valid: [
    // A page from the registry.
    `const A = () => <Link to={NAV_PAGES.settings.to}>Settings</Link>;`,
    `const items = [{ label: NAV_PAGES.people.label, to: NAV_PAGES.people.to }];`,
    // A record, built by its path helper.
    `const A = () => <Link to={conversationPath(id)}>Open</Link>;`,
    "const A = () => <Link to={`${workspacePath(id)}/edit`}>Edit</Link>;",
    // A redirect is not a link that a reader picks.
    `const A = () => <Navigate replace to="/" />;`,
    // Not a dashboard path.
    `const A = () => <Link to="#activity">Activity</Link>;`,
    `const range = { from: "a", to: "b" };`,
  ],
  invalid: [
    {
      code: `const A = () => <Link to="/settings">Settings</Link>;`,
      errors: literalPath,
    },
    {
      code: `const A = () => <DropdownMenuLinkItem render={<Link to={"/admin"} />} />;`,
      errors: literalPath,
    },
    {
      code: "const A = () => <NavLink to={`/automations/runs?${params}`} />;",
      errors: literalPath,
    },
    {
      code: `const items = [{ label: "People", to: "/system/people" }];`,
      errors: literalPath,
    },
    {
      code: "const row = { id, label, to: `/settings#${anchor}` };",
      errors: literalPath,
    },
    {
      code: `const item = { "to": "/code" };`,
      errors: literalPath,
    },
  ],
});
