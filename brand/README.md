# Junior brand assets

`junior-fullbody.png` is the original full-body Junior illustration. Keep it unchanged. Make all other Junior images from it.

Use two crops:

- **Avatar crop:** head, cap, antennas, the top of the hoodie, and the phone. It is a square cut from the top of the image to the middle of the hoodie. Use it for the logo and avatar.
- **Head crop:** head, cap, and antennas only, centered in a transparent square. It stops at the bottom edge of the head. Use it for favicons, because the avatar crop is not readable at 16px.

| Image                                                     | Crop      | Size     |
| --------------------------------------------------------- | --------- | -------- |
| `packages/docs/public/junior-character.png`               | Full body | 576 wide |
| `packages/docs/public/junior-mark.png`                    | Avatar    | 192x192  |
| `packages/docs/public/favicon.png`                        | Head      | 96x96    |
| `packages/junior-dashboard/src/assets/junior-avatar.png`  | Avatar    | 512x512  |
| `packages/junior-dashboard/src/assets/junior-favicon.png` | Head      | 96x96    |

The dashboard uses `junior-avatar.png` for the header logo and the install icon. It uses `junior-favicon.png` for `/favicon.ico`.
