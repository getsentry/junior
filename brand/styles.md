# Junior visual styles

Junior has two visual styles. Both use the brand colors in
[README.md](README.md#colors). They differ in how much of the page those colors
and shapes take.

| Style     | Use it for                                                          | Reference                         |
| --------- | ------------------------------------------------------------------- | --------------------------------- |
| Product   | Artifacts, demo videos, and any page that explains a thing          | `packages/junior-dashboard`       |
| Marketing | The docs site, stickers, the mascot, and launch posts               | `packages/docs/src/styles/custom.css` |

Product is the default. Use Marketing only for the surfaces in its row, or when
a person asks for it. Slides keep the style in the `create-slides` skill.

## The difference

| Part        | Product                                                        | Marketing                                       |
| ----------- | -------------------------------------------------------------- | ----------------------------------------------- |
| Canvas      | Flat white, or near-black in dark mode. No texture.            | Cream or ink, with a dot grid.                  |
| Borders     | 1px hairlines at 6 to 16% opacity of the text color.           | 2 to 4px solid ink or cream.                    |
| Shadows     | None on the page. A soft shadow only on floating layers, such as menus and toasts. | Hard violet or ink offsets, 3 to 10px. |
| Corners     | 6px on controls, 8px on cards and panels, full on pills.       | Square.                                         |
| Type        | Outfit semibold for titles and headings, Inter for text. Mono only for code, ids, and paths. | Rubik or Arial Black at 800 to 950, mono `// kickers`, Caveat notes. |
| Color       | Neutral grays, plus violet as the one accent.                  | Yellow, pink, and violet at full strength.      |
| Hierarchy   | Space, weight, and muted text.                                 | Size, color blocks, and outlines.               |
| Buttons     | Primary is solid violet. Others have a hairline border.        | Pink, pressed into a hard shadow.               |

## Product

### Color

| Role             | Light     | Dark      |
| ---------------- | --------- | --------- |
| Canvas           | `#ffffff` | `#060607` |
| Panel            | `#f9f9fa` | `#0c0c0e` |
| Text             | `#18181b` | `#f4f4f5` |
| Muted text       | `#52525b` | `#a1a1aa` |
| Border           | `rgb(0 0 0 / 0.09)` | `rgb(255 255 255 / 0.08)` |
| Accent text, focus, selection | `#6c4c9c` | `#a98ad6` |
| Primary button   | `#6c4c9c` with white text | `#6c4c9c` with white text |
| Accent tint      | accent at 8 to 12% opacity | accent at 12 to 16% opacity |

- Violet is the only accent. Use it for links, focus rings, the selected item,
  the one primary action, and small tags.
- Brand violet `#6c4c9c` is 2.9:1 on the dark canvas. On dark, use `#a98ad6`
  (6.8:1) for text, icons, and focus rings.
- Yellow and pink do not appear in Product UI. The mascot keeps its colors.
- Status colors (success, warning, danger) are for status only, and always
  have a text label.
- A chart has at most four series. Start with violet, then neutral grays,
  then status hues if the data has a status.

### Type

| Step    | Size  | Weight | Use                       |
| ------- | ----- | ------ | ------------------------- |
| Title   | 30 to 36px | 600 | One page or slide title. |
| Section | 20px  | 600    | Section headings.         |
| Label   | 16px  | 600    | Card and question titles. |
| Body    | 16px  | 400    | Text.                     |
| Meta    | 13 to 14px | 400 | Dates, counts, sources, in muted text. |

- Titles and section headings use Outfit. Everything else uses Inter.
- Line height is 1.5 for body and 1.2 for titles.
- Use tabular numbers for counts, times, and prices.

### Layout

- Space on a 4px grid. Group with space first, then with a hairline, then with
  a panel fill. Do not nest bordered boxes more than two levels.
- One idea per view. Lead with the title, then one line of context.
- Lists are rows with hairline dividers, not a card for each row.

### Motion

- 150 to 200ms, ease-out. Fade and short slides only. No bounces.
- Respect reduced motion.

### Do not use

Gradients, glows, blur, glass panels, hard offset shadows, dot grids, borders
thicker than 1px (except a 2px focus ring or selected tab underline), and emoji
as icons.

## Marketing

Marketing is the docs site style. `packages/docs/src/styles/custom.css` is its
source. It uses the brand colors at full strength: yellow headlines, pink
buttons and stickers, violet hard shadows, square corners, heavy display type,
and a dot grid. Do not use it for artifacts or videos unless a person asks for
it.
