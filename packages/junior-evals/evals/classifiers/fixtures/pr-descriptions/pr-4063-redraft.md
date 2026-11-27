`e2e/inbox/settings.spec.ts` › "new UI › marks the section in view in the pane on pages of sections" is flaky. It fails with `toHaveAttribute` timeouts, then passes on retry. That happened on main ([run 45071295499](https://github.com/getsentry/junior/actions/runs/45071295499/job/137360156318)) and on getsentry/junior#4056, which does not touch this code ([run 45080295994](https://github.com/getsentry/junior/actions/runs/45080295994/job/137386961049)).

## Root cause

After a section link is clicked, the test moves the reader back up with `page.evaluate(() => window.scrollTo(0, 0))`. `AnchorHeading` holds a followed heading in view until reader input arrives: keydown, pointerdown, touchstart, or wheel. It counts a bare scroll event as the reader only if the page height has not changed since its last scroll.

In both failures a late read landed in the same frame as the script scroll:
- Settings: the personal-tokens list.
- Memories: the dashboard data.

So the scroll looked like layout, and the `ResizeObserver` scrolled the heading back. The final trace frames show the followed heading back at the top. A real wheel or scrollbar click sends input that releases the heading at once, so the app is not at fault here.

## Change

The journey now scrolls up with `page.mouse.wheel` over the heading in view, as a reader does. The `dashboard-spec-page-script` baseline for this spec drops from 8 to 6.
