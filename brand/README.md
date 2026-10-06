# Junior brand assets

`junior-fullbody.png` is the full-body Junior illustration on a transparent background. All other images are crops of it. Do not redraw or edit the character in the crops.

`junior-avatar-512-cream.png` is the approved avatar. Use it as the reference for new avatars and reactions.

Use these crops:

- **Avatar crop:** a close view of the head, cap, all three antennas, and hoodie collar. The eye and smile must be clear at small sizes. Omit the phone, hands, and arms. Use it for the logo and avatar.
- **Profile avatar:** the avatar crop on a solid square. The face is large and centered, and the hoodie touches the bottom edge. Keep the eye and smile inside a circle for round avatar frames.
- **Head crop:** head, cap, and top antenna only, centered in a transparent square. It stops at the bottom edge of the head. Omit the side antennas so that the face fills the square. Use it for favicons, because the avatar crop is not readable at 16px.

| Image                                                     | Crop           | Size    |
| --------------------------------------------------------- | -------------- | ------- |
| `packages/docs/public/junior-character.png`               | Full body      | 576x920 |
| `packages/docs/public/junior-mark.png`                    | Avatar         | 192x192 |
| `packages/docs/public/favicon.png`                        | Head           | 96x96   |
| `packages/junior-dashboard/src/assets/junior-avatar.png`  | Avatar         | 512x512 |
| `packages/junior-dashboard/src/assets/junior-favicon.png` | Head           | 96x96   |
| `brand/junior-avatar-512-cream.png`                       | Profile avatar | 512x512 |
| `brand/junior-avatar-512-dark.png`                        | Profile avatar | 512x512 |

The dashboard uses `junior-avatar.png` for the header logo and the install icon. It uses `junior-favicon.png` for `/favicon.ico`.

## Profile avatars

Use a profile avatar where a service asks for a square account image, for example the Slack app icon. These images have no transparency, so they look the same on light and dark themes.

| Image                         | Background | Use                                               |
| ----------------------------- | ---------- | ------------------------------------------------- |
| `junior-avatar-512-cream.png` | Cream      | Default. It has the best contrast at small sizes. |
| `junior-avatar-512-dark.png`  | Ink        | Use it when the service has a light background.   |

Do not put Junior on a yellow, violet, or pink background. The mascot uses these colors, so parts of it disappear.

## Slack reactions

These images have transparent backgrounds. Both exports are 128x128 and under 128 KB.

| Image                       | Emoji name        | Use                                     |
| --------------------------- | ----------------- | --------------------------------------- |
| `slack/junior-thinking.gif` | `junior-thinking` | Thinking. The dots in the bubble cycle. |
| `slack/junior-done.png`     | `junior-done`     | Done. Junior has a large green check.   |

Upload the exports as custom emoji in the Slack workspace. Then set the host's `slack.processingReactionEmoji` to `junior-thinking` and `slack.completedReactionEmoji` to `junior-done`. The runtime defaults stay unchanged until the custom emoji are installed.

`slack/junior-thinking-frames.png` holds four frames in a 2x2 square. Read them left to right, then top to bottom. `slack/junior-done-source.png` holds the 512x512 source for the done icon. Keep these source images when you update the exports.

To export them again with ImageMagick:

```sh
convert -delay 35 -dispose Background brand/slack/junior-thinking-frames.png \
  -crop 256x256 +repage -filter Lanczos -resize 128x128 \
  -channel A -threshold 50% +channel -colors 128 -strip -loop 0 \
  brand/slack/junior-thinking.gif
convert brand/slack/junior-done-source.png -filter Lanczos -resize 128x128 \
  -strip -define png:compression-level=9 brand/slack/junior-done.png
```

## Colors

These colors come from the mascot. The docs site defines them as CSS variables in `packages/docs/src/styles/custom.css`.

| Name   | Hex       | CSS variable  | Use                                                   |
| ------ | --------- | ------------- | ----------------------------------------------------- |
| Yellow | `#fcb818` | `--jr-yellow` | Main accent. Headlines, the current page, highlights. |
| Violet | `#6c4c9c` | `--jr-violet` | Second accent. Shadows, section backgrounds, tags.    |
| Pink   | `#ec4c98` | `--jr-pink`   | Buttons and stickers.                                 |
| Cream  | `#fff7df` | `--jr-cream`  | Light background and text on dark backgrounds.        |
| Ink    | `#181024` | `--jr-black`  | Dark background, outlines, and text on light colors.  |

The illustration also uses plum `#984498` on the cap and off-white `#f4f4f8` on the eye and teeth. Do not use them as interface colors.

Text contrast:

- Put ink text on yellow (10.6:1), pink (5.3:1), and cream (17.2:1).
- Put cream text on violet (6.2:1) and ink (17.2:1).
- Do not use violet for small text on ink (2.8:1). It is below the WCAG minimum of 4.5:1.
