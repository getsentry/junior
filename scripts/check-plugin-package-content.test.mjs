import assert from "node:assert/strict";
import test from "node:test";
import { checkPluginPackageContent } from "./check-plugin-package-content.mjs";

const registration = (name) => ({
  file: "packages/junior-x/src/index.ts",
  text: `defineJuniorPlugin({\n  packageName: ${JSON.stringify(name)},\n});`,
});

test("reports a factory package that declares packageName and ships only code", () => {
  const [error, ...rest] = checkPluginPackageContent([
    {
      dir: "packages/junior-x",
      name: "@sentry/junior-x",
      files: ["dist"],
      sources: [registration("@sentry/junior-x")],
    },
  ]);
  assert.deepEqual(rest, []);
  assert.match(
    error,
    /packages\/junior-x\/src\/index\.ts: declares packageName/,
  );
});

test("allows packages that publish plugin content or declare no packageName", () => {
  assert.deepEqual(
    checkPluginPackageContent([
      {
        dir: "packages/junior-skills",
        name: "@sentry/junior-skills",
        files: ["dist", "skills/"],
        sources: [registration("@sentry/junior-skills")],
      },
      {
        dir: "packages/junior-code",
        name: "@sentry/junior-code",
        files: ["dist"],
        sources: [{ file: "packages/junior-code/src/index.ts", text: "" }],
      },
    ]),
    [],
  );
});
