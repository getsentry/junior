# Junior brand assets

## Crops

- `junior-fullbody.png` is the source: the full-body illustration on a
  transparent background. All other images are crops of it. Do not redraw or
  edit the character.
- `junior-avatar-512-cream.png` is the approved avatar. Use it as the
  reference for new avatars and reactions.
- **Avatar crop:** head and shoulders, with the cap, all three antennas, the
  hoodie top, and both shoulder joints. Remove the raised hand and the music
  player. Use it for the logo, avatars, favicons, and Slack reactions.
- **Profile avatar:** the avatar crop on a solid square. Keep the eye and
  smile inside a circle for round frames.
- Every crop shows at least the head and shoulders. Do not use a head-only
  crop, also for favicons.
- Cut the character only at the frame edges. Crop first, then keep only the
  parts that connect to the head.
- Do not dither the palette when you compress. Dithering adds colored dots at
  small sizes.

| Image                                                     | Crop           | Size    |
| --------------------------------------------------------- | -------------- | ------- |
| `packages/docs/public/junior-character.png`               | Full body      | 576x920 |
| `packages/docs/public/junior-mark.png`                    | Avatar         | 192x192 |
| `packages/docs/public/favicon.png`                        | Avatar         | 96x96   |
| `packages/junior-dashboard/src/assets/junior-avatar.png`  | Avatar         | 512x512 |
| `packages/junior-dashboard/src/assets/junior-favicon.png` | Avatar         | 96x96   |
| `brand/junior-avatar-512-cream.png`                       | Profile avatar | 512x512 |
| `brand/junior-avatar-512-dark.png`                        | Profile avatar | 512x512 |

## Profile avatars

Use a profile avatar where a service asks for a square account image, such as
the Slack app icon. Use cream by default. Use dark when the service has a light
background. Do not put Junior on yellow, violet, or pink; parts of the mascot
disappear.

## Slack reactions

| Image                       | Emoji name        | Use                                     |
| --------------------------- | ----------------- | --------------------------------------- |
| `slack/junior-thinking.gif` | `junior-thinking` | Thinking. The dots in the bubble cycle. |
| `slack/junior-done.png`     | `junior-done`     | Done. A large green check.              |

- Exports are 128x128, transparent, and under 128 KB. Keep the sources
  `slack/junior-thinking-frames.png` (2x2 frames, left to right, then top to
  bottom) and `slack/junior-done-source.png` (512x512).
- Upload the exports as custom emoji. Then set `slack.processingReactionEmoji`
  to `junior-thinking` and `slack.completedReactionEmoji` to `junior-done`.

```sh
convert -delay 35 -dispose Background brand/slack/junior-thinking-frames.png \
  -crop 256x256 +repage -filter Lanczos -resize 128x128 \
  -channel A -threshold 50% +channel -colors 128 -strip -loop 0 \
  brand/slack/junior-thinking.gif
convert brand/slack/junior-done-source.png -filter Lanczos -resize 128x128 \
  -strip -define png:compression-level=9 brand/slack/junior-done.png
```

## Colors

`packages/docs/src/styles/custom.css` defines these as CSS variables.

| Name   | Hex       | CSS variable  | Use                                     |
| ------ | --------- | ------------- | --------------------------------------- |
| Yellow | `#fcb818` | `--jr-yellow` | Main accent: headlines, current page.   |
| Violet | `#6c4c9c` | `--jr-violet` | Second accent: shadows, sections, tags. |
| Pink   | `#ec4c98` | `--jr-pink`   | Buttons and stickers.                   |
| Cream  | `#fff7df` | `--jr-cream`  | Light background, text on dark.         |
| Ink    | `#181024` | `--jr-black`  | Dark background, outlines, text.        |

- Plum `#984498` and off-white `#f4f4f8` are only for the illustration, not the
  interface.
- Put ink text on yellow, pink, or cream. Put cream text on violet or ink.
- Do not use violet for small text on ink (2.8:1, below WCAG 4.5:1).
