---
name: headshot
description: Removes the background from an uploaded headshot or portrait photo and replaces it with the branded purple-dots background, or a solid color on explicit request. Use when someone shares a photo of a person and asks for a branded headshot or profile photo, or asks to remove, replace, or change the background. Do not use for generating new images from a prompt, changing faces, clothing, or lighting, or editing photos without people.
---

# Headshot

Use the bundled `scripts/replace-background.py` from this directory. It cuts out the person with a segmentation model, keeps soft hair edges, and composites the person onto the new background. Do not draw masks by hand or approximate a cutout another way.

## Workflow

1. Find the photo in the current message or thread. Use `loadAttachment` to put it in the Sandbox. Process one photo per run.
2. Choose the background. Keep headshots consistent:
   - Use `--background purple-dots` by default. This includes requests for a branded headshot and requests that do not name a background.
   - Use `--color` only when the user explicitly asks for a solid color. Convert the color to a hex value such as `#1F1633`.
   - Do not ask which background to use.
3. Run the script with a new output path. Use `.png` unless the user asks for a smaller file; then use `.jpg`.

   ```sh
   ~/.junior-headshot/bin/python scripts/replace-background.py \
     --input <attachment path> \
     --output /tmp/junior/artifacts/headshot-<name>.png \
     --background purple-dots
   ```

4. Look at the result with `viewImage` when it is available. Check for old background left near the hair, missing parts of the person, or other objects that stayed in.
5. Use `sendFiles` to deliver the `path` and `mimeType` from the script's JSON result. Say which background you used. Report any visible problems.

## Bundled Backgrounds

| Name          | Look                                                                  |
| ------------- | --------------------------------------------------------------------- |
| `purple-dots` | Dark purple. Lighter purple dots fill the lower half and fade upward. |

The script scales and crops a background to cover the photo. The photo keeps its size, up to 2048 pixels on the longest edge.

## Failures

- Missing `~/.junior-headshot/bin/python`, `ModuleNotFoundError`, or a model download: report a plugin setup failure. Ask the operator to rebuild the Sandbox snapshot. Do not install packages and do not continue with a hand-made cutout.
- `unknown background`: tell the user the available names from the error.
- `File exists`: run again with a new output path. Do not delete files you did not create.
- The cutout includes a second person or an object, or cuts off part of the person: send the result, describe the problem, and offer to try a different photo. The script has no manual mask option.
