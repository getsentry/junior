#!/usr/bin/env node
// Drive the dashboard of a verification run with Playwright, one step at a
// time, and save evidence. Steps run in the order given.
//
// Usage:
//   node browse.mjs --out DIR [--base URL] [--width PX] [--touch] [--timeout MS] STEP...
// --touch emulates a phone: a touch screen at --width (use 390) by 844.
// --timeout sets the wait of each step (default 30000). A live Turn can take
// minutes, so give drives that wait for a reply 300000 or more.
// Steps:
//   --goto PATH            Open PATH on the base URL (default http://localhost:3000).
//   --back NAME            Open the URL that an earlier --snap NAME saved in DIR.
//   --click SELECTOR       Click a Playwright selector, such as 'role=button[name="Hold"]'.
//   --fill SELECTOR=TEXT   Type TEXT into the element.
//   --type SELECTOR=TEXT   Type TEXT into the element key by key, as a person does.
//   --hover SELECTOR       Move the pointer over the element and leave it there.
//   --tap SELECTOR         Tap the element. Needs --touch.
//   --press KEY            Press a key on the focused element, such as Enter.
//   --upload SELECTOR=PATH Set the file of a file input, such as 'role=button[name="Choose files"]'.
//                          Repeat PATH with commas for several files.
//   --select SELECTOR      Select all the text of the element, as a mouse drag does.
//   --expect SELECTOR      Wait until the element is visible. Fails the run if it is not.
//   --absent SELECTOR      Wait until no such element is visible. Fails the run if one stays.
//   --title TEXT           Wait until the tab title starts with TEXT.
//   --order A|B|C          Wait until the page text has A, then B, then C.
//   --idle                 Wait until the open Conversation has no running Turn: no
//                          "Stop" button and no "is thinking…" status for 3 seconds.
//                          Takes no value.
//   --snap NAME            Write NAME.aria.yml (ARIA snapshot), NAME.png, NAME.title.txt, and NAME.url.txt to DIR.
// Every step and its result go to DIR/steps.log. The exit code is 0 only
// when every step passes.
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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
let timeout = 30_000;
let touch = false;
const steps = [];
for (let i = 0; i < args.length; i += 2) {
  if (args[i] === "--idle") {
    steps.push(["idle", ""]);
    i -= 1;
    continue;
  }
  if (args[i] === "--touch") {
    touch = true;
    i -= 1;
    continue;
  }
  const [flag, value] = [args[i], args[i + 1]];
  if (value === undefined) throw new Error(`${flag} needs a value`);
  if (flag === "--out") out = value;
  else if (flag === "--base") base = value;
  else if (flag === "--width") width = Number(value);
  else if (flag === "--timeout") timeout = Number(value);
  else steps.push([flag.slice(2), value]);
}
if (!out) throw new Error("--out DIR is required");
mkdirSync(out, { recursive: true });
const log = (line) => {
  appendFileSync(join(out, "steps.log"), `${line}\n`);
  console.log(line);
};

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width, height: touch ? 844 : 900 },
  hasTouch: touch,
  isMobile: touch,
});
page.setDefaultTimeout(timeout);
let failed = false;
try {
  for (const [step, value] of steps) {
    try {
      if (step === "goto") await page.goto(new URL(value, base).href);
      else if (step === "back")
        await page.goto(readFileSync(join(out, `${value}.url.txt`), "utf8"));
      else if (step === "click") await page.locator(value).first().click();
      else if (step === "fill") {
        const at = value.lastIndexOf("=");
        await page
          .locator(value.slice(0, at))
          .first()
          .fill(value.slice(at + 1));
      } else if (step === "type") {
        const at = value.lastIndexOf("=");
        await page
          .locator(value.slice(0, at))
          .first()
          .pressSequentially(value.slice(at + 1));
      } else if (step === "hover") await page.locator(value).first().hover();
      else if (step === "tap") await page.locator(value).first().tap();
      else if (step === "press") await page.keyboard.press(value);
      else if (step === "upload") {
        const at = value.lastIndexOf("=");
        await page
          .locator(value.slice(0, at))
          .first()
          .setInputFiles(value.slice(at + 1).split(","));
      } else if (step === "select") {
        const target = page.locator(value).first();
        await target.scrollIntoViewIfNeeded();
        await target.evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          // The dashboard reads the selection after the pointer comes up.
          element.dispatchEvent(
            new PointerEvent("pointerup", { bubbles: true }),
          );
          element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        });
      } else if (step === "expect")
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
      else if (step === "idle") {
        // Each --idle starts its own 3-second window. A mark from an earlier
        // --idle on this page would pass before the next Turn shows as busy.
        await page.evaluate(() => delete window.__idleSince);
        await page.waitForFunction(
          () => {
            const busy =
              [...document.querySelectorAll("button")].some(
                (b) =>
                  b.textContent?.trim() === "Stop" || b.ariaLabel === "Stop",
              ) || /is thinking…/.test(document.body.innerText);
            const now = Date.now();
            window.__idleSince = busy ? now : (window.__idleSince ?? now);
            return !busy && now - window.__idleSince >= 3000;
          },
          undefined,
          { polling: 500 },
        );
      } else if (step === "snap") {
        await page.waitForLoadState("networkidle");
        writeFileSync(
          join(out, `${value}.aria.yml`),
          await page.locator("body").ariaSnapshot(),
        );
        writeFileSync(join(out, `${value}.title.txt`), await page.title());
        writeFileSync(join(out, `${value}.url.txt`), page.url());
        await page.screenshot({ path: join(out, `${value}.png`) });
      } else throw new Error(`unknown step --${step}`);
      log(`ok    --${step} ${value}`);
    } catch (error) {
      log(`FAIL  --${step} ${value}: ${error.message.split("\n")[0]}`);
      // The browser can be gone when a signal ended the run. Keep the log line.
      await page.screenshot({ path: join(out, "failure.png") }).catch(() => {});
      failed = true;
      break;
    }
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
