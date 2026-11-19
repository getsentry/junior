# Slide Design

Rules for slides that look made by a person. Each rule fixes a common
mistake in generated decks.

## Content

- **One point per slide.** When a slide needs two titles, make two slides.
- **The title states the point.** Write "Checkout errors fell 40% after the
  retry fix", not "Checkout errors". A reader who reads only the titles gets
  the story.
- **Cut the text.** At most 6 bullets, at most about 12 words each, and no
  full paragraphs. Move detail, sources, and caveats to the speaker notes.
- **Show numbers big.** One key number gets its own large text box, with a
  short label below it. Do not bury it in a bullet.
- **Vary the slide types.** A deck of only title-and-bullets slides is the
  most common mistake. Use section headers, a big number, a two-column
  comparison, a short quote, a table, a chart, or an image where they fit.
- **Use the requester's words and data.** Do not invent numbers, quotes, or
  customer names. When the source has no data for a chart, do not make one.

## Match the deck

- Read a slide like the one that you make, and copy its title position,
  font, size, and color. Placeholders and duplicated slides do this for you.
- Use theme colors (`themeColor`) and the deck's fonts. Use an RGB color
  only when the deck itself uses that color.
- Keep the deck's text case and tone, such as sentence case titles.
- When the deck has no slides yet, use its layouts, and keep the theme's
  defaults.

## Grid

Define the grid once, then use the same numbers on every slide. For a
720 × 405 pt page:

| Item         | Value                                         |
| ------------ | --------------------------------------------- |
| Outer margin | 36 to 48 pt on each side                      |
| Title box    | top 24 to 36 pt, height 50 to 70 pt           |
| Body area    | starts 16 to 24 pt below the title box        |
| Gutter       | 16 to 24 pt between columns and between cards |
| Columns      | equal widths: (content width - gutters) / n   |

- Align left edges. Elements of the same kind have the same size.
- Keep every element inside the margins, except a full-bleed image or
  background shape.
- Leave space empty. A slide that is 40% empty is fine.

## Type

| Text          | Size on a 720 pt wide page |
| ------------- | -------------------------- |
| Title         | 28 to 36 pt                |
| Body, bullets | 16 to 20 pt                |
| Big number    | 60 to 96 pt                |
| Labels, notes | 12 to 14 pt, never less    |

- Left-align body text. Center only short titles, big numbers, and quotes.
- Use bold for a few words, not whole bullets.
- When the text does not fit, cut words or split the slide. Do not make the
  font smaller than the table above.

## Make text fit

Google cannot shrink text to fit from the API, so estimate before you
create the box:

- Characters per line ≈ box width in pt / (0.5 × font size). For a
  condensed font use 0.45, and for a wide font use 0.55.
- Lines = sum over paragraphs of ceil(paragraph characters / characters per
  line).
- Box height ≈ lines × 1.2 × font size, plus about 15 pt for the box's
  insets, plus paragraph spacing.

This is an estimate. The thumbnail is the check: when text touches the
bottom edge of its box or of another element, it does not fit.

## Color and contrast

- Dark text on a light background, or light text on a dark one. Do not put
  text on a busy image without a solid shape behind it.
- Use one accent color for emphasis. Use more colors only for categories in
  a chart or diagram.

## Images, tables, and diagrams

- Give an image a box with the same aspect ratio. Otherwise Google makes
  the image smaller than the box, to keep its ratio, and centers it.
- A table has at most about 5 columns and 6 rows. Bold the header row. Make
  a chart from larger data.
- Build a diagram from shapes and lines on a blank slide. Align the shapes
  on the grid, and give them the same size. Group them with `groupObjects`
  when they move together.

## Check each slide

Look at the thumbnail and check:

- No text overflows, is cut off, or touches another element.
- No element is off the page or outside the margins without a reason.
- No placeholder is empty.
- The title and body are where they are on the other slides.
- The slide is clear at a glance: one point, read in 5 seconds.
