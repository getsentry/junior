# Memories pages

`MemoryPage` shows the Memories overview and the memory library. The memory
plugin supplies the records. The dashboard owns the layout.

## Memory details

The URL selects one memory: `/memories/:memoryId`. Select the row again to
close the details. Closing keeps the list query string, so search and filter
stay the same. A permalink loads its memory directly, so the memory does not
need to be on a loaded list page. A stale or unknown permalink goes back to
the library.

`MemoryDetails` uses the shared `DetailsPanel`. At 1280px and above, a 400px
panel shows beside the list. Below that width, a bottom sheet shows the
details. The list stays usable beside the panel. Each pane scrolls on its own.
`MemoryPageLayout` fills the viewport on library routes, and
`VisualViewportShell` owns the viewport height.

The header names the memory by visibility and type, such as "Private
preference". The body shows the memory text, then one card of fact rows: how
Junior learned it, where Junior uses it, and its dates. Each row has the label
on the left and the value on the right, like the stats in the Conversation
details Summary tab. Observed is hidden when it is the same as Remembered.

Forget is an icon button in the panel header. In the sheet, it is in the
footer. It asks for confirmation with `ui/alert-dialog` before it runs. A
second click on the confirm button does not send a second request. Forget
closes the details and moves focus to the list, because the row goes away.
Close and Escape move focus back to the selected row.

`e2e/memories.spec.ts` covers selection, focus, the mobile sheet, and the
forget confirmation. Use manual QA for layout in both themes.
