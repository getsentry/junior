#!/usr/bin/env node
// Drive the dashboard of a verification run with Playwright, one step at a
// time, and save evidence. Steps run in the order given.
//
// Usage:
//   node browse.mjs --out DIR [--base URL] [--width PX] STEP...
// Steps:
//   --goto PATH            Open PATH on the base URL (default http://localhost:3000).
//   --click SELECTOR       Click a Playwright selector, such as 'role=button[name="Hold"]'.
//   --fill SELECTOR=TEXT   Type TEXT into the element.
//   --press KEY            Press a key on the focused element, such as Enter.
//   --expect SELECTOR      Wait until the element is visible. Fails the run if it is not.
//   --absent SELECTOR      Wait until no such element is visible. Fails the run if one stays.
//   --title TEXT           Wait until the tab title starts with TEXT.
//   --order A|B|C          Wait until the page text has A, then B, then C.
//   --snap NAME            Write NAME.aria.yml (ARIA snapshot), NAME.png, and NAME.title.txt to DIR.
// Every step and its result go to DIR/steps.log. The exit code is 0 only
// when every step passes.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: import.meta.dirname,
  encoding: "utf8",
}).trim();
const { chromium } = createRequire(join(repoRoot, "package.json"))(
  "@playwright/test",
);

const args = process.argv.slice(2);
let out;
let base = "http://localhost:3000";
let width = 1440;
const steps = [];
for (let i = 0; i < args.length; i += 2) {
  const [flag, value] = [args[i], args[i + 1]];
  if (value === undefined) throw new Error(`${flag} needs a value`);
  if (flag === "--out") out = value;
  else if (flag === "--base") base = value;
  else if (flag === "--width") width = Number(value);
  else steps.push([flag.slice(2), value]);
}
if (!out) throw new Error("--out DIR is required");
mkdirSync(out, { recursive: true });
const log = (line) => {
  appendFileSync(join(out, "steps.log"), `${line}\n`);
  console.log(line);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width, height: 900 } });
let failed = false;
try {
  for (const [step, value] of steps) {
    try {
      if (step === "goto") await page.goto(new URL(value, base).href);
      else if (step === "click") await page.locator(value).first().click();
      else if (step === "fill") {
        const at = value.lastIndexOf("=");
        await page
          .locator(value.slice(0, at))
          .first()
          .fill(value.slice(at + 1));
      } else if (step === "press") await page.keyboard.press(value);
      else if (step === "expect")
        await page.locator(value).first().waitFor({ state: "visible" });
      else if (step === "absent")
        await page.locator(value).first().waitFor({ state: "hidden" });
      else if (step === "title")
        await page.waitForFunction(
          (title) => document.title.startsWith(title),
          value,
        );
      else if (step === "order")
        await page.waitForFunction((parts) => {
          const at = parts.map((part) => document.body.innerText.indexOf(part));
          return at.every(
            (index, i) => index >= 0 && (i === 0 || index > at[i - 1]),
          );
        }, value.split("|"));
      else if (step === "snap") {
        await page.waitForLoadState("networkidle");
        writeFileSync(
          join(out, `${value}.aria.yml`),
          await page.locator("body").ariaSnapshot(),
        );
        writeFileSync(join(out, `${value}.title.txt`), await page.title());
        await page.screenshot({ path: join(out, `${value}.png`) });
      } else throw new Error(`unknown step --${step}`);
      log(`ok    --${step} ${value}`);
    } catch (error) {
      log(`FAIL  --${step} ${value}: ${error.message.split("\n")[0]}`);
      await page.screenshot({ path: join(out, "failure.png") });
      failed = true;
      break;
    }
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
