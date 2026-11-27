`e2e/inbox/settings.spec.ts` › "new UI › marks the section in view in the pane on pages of sections" fails at random with `expect(locator).toHaveAttribute(expected) failed, Timeout: 10000ms`. It failed, then passed on retry, in two places:

- main: [run 45071295499](https://github.com/getsentry/junior/actions/runs/45071295499/job/137360156318). Memories "Activity" was never marked.
- getsentry/junior#4056, which does not touch this code: [run 45080295994](https://github.com/getsentry/junior/actions/runs/45080295994/job/137386961049). Settings "General" was never marked.

## Root cause

After a section link is clicked, the test moves the reader back up with `page.evaluate(() => window.scrollTo(0, 0))`. `AnchorHeading` holds a followed heading in view until reader input (keydown, pointerdown, touchstart, wheel) arrives. It counts a bare scroll event as the reader only if the page height has not changed since its last scroll. Otherwise it treats the scroll as layout.

In both failures a late read landed in that same window:
- Settings: the personal-tokens list.
- Memories: the dashboard data.

So the script scroll looked like layout, and the `ResizeObserver` scrolled the heading back. The final trace frames show Identities and "How they got here" back at the top. A real wheel or scrollbar click sends input that releases the heading at once; Chromium sends pointerdown for a click on the root scrollbar. This is the test pretending to be the reader with page script, not an app bug.

## Fix

The journey now scrolls up with `page.mouse.wheel` over the heading in view, as a reader does. The `dashboard-spec-page-script` baseline for this spec drops from 8 to 6.

## Local runs

All runs use `--project=inbox`.

- A scratch probe grows the page in the same task as the scroll. With `scrollTo` it failed 10/10. With the wheel it passed 10/10.
- A copy of the old test under 6x CPU throttling failed 2 of 26 runs, with the same error as on main.
- After the fix:
  - `pnpm test:e2e:dashboard … --repeat-each=40`: 40/40 passed.
  - 6x throttled: 30/30 passed.
