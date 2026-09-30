# Junior brand assets

`junior-fullbody.png` is the original full-body Junior illustration. Keep it unchanged. Make all other Junior images from it.

Use these crops:

- **Avatar crop:** head, cap, antennas, the top of the hoodie, and the phone. It is a square cut from the top of the image to the middle of the hoodie. Use it for the logo and avatar.
- **Profile avatar:** the avatar crop at 80% size on a solid square. It is centered, and the hoodie touches the bottom edge. The antennas and the phone stay inside a circle, so the image is safe for round and rounded-square avatar frames.
- **Head crop:** head, cap, and antennas only, centered in a transparent square. It stops at the bottom edge of the head. Use it for favicons, because the avatar crop is not readable at 16px.

| Image                                                     | Crop           | Size     |
| --------------------------------------------------------- | -------------- | -------- |
| `packages/docs/public/junior-character.png`               | Full body      | 576 wide |
| `packages/docs/public/junior-mark.png`                    | Avatar         | 192x192  |
| `packages/docs/public/favicon.png`                        | Head           | 96x96    |
| `packages/junior-dashboard/src/assets/junior-avatar.png`  | Avatar         | 512x512  |
| `packages/junior-dashboard/src/assets/junior-favicon.png` | Head           | 96x96    |
| `brand/junior-avatar-512-cream.png`                       | Profile avatar | 512x512  |
| `brand/junior-avatar-512-dark.png`                        | Profile avatar | 512x512  |

The dashboard uses `junior-avatar.png` for the header logo and the install icon. It uses `junior-favicon.png` for `/favicon.ico`.

## Profile avatars

Use a profile avatar where a service asks for a square account image, for example the Slack app icon. These images have no transparency, so they look the same on light and dark themes.

| Image                         | Background | Use                                               |
| ----------------------------- | ---------- | ------------------------------------------------- |
| `junior-avatar-512-cream.png` | `#fff7df`  | Default. It has the best contrast at small sizes. |
| `junior-avatar-512-dark.png`  | `#181024`  | Use it when the service has a light background.   |

Do not put Junior on a yellow, violet, or pink background. The mascot uses these colors, so parts of it disappear.

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
