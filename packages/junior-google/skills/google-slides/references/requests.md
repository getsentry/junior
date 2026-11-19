# Slides API Requests

Recipes for `updateGoogleSlides`. Each item in `requests` has one key, the
request kind. Field names are camelCase. Full reference:
https://developers.google.com/workspace/slides/api/reference/rest/v1/presentations/request

## Ids and units

- Object ids are 5 to 50 characters: letters, digits, `_`, `-`, and `:`.
  The first character is a letter, a digit, or `_`. Each id must be new in
  the deck. Use a prefix and a counter, such as `jr_s07` for a slide and
  `jr_s07_title` for its title.
- Reads return sizes and positions in EMU. 12700 EMU is 1 pt, and 914400
  EMU is 1 inch. Writes can use `"unit": "PT"`, which is easier to compute.
- A 16:9 deck is usually 720 × 405 pt. Read `pageSize` to be sure.
- The size that people see is `size × scale`. Elements that you read often
  have a scale other than 1. Multiply before you compare or copy geometry.
- `translateX` and `translateY` are the top-left corner of the element.

## Blank slide with a title and a body

```json
[
  { "createSlide": { "objectId": "jr_s07", "insertionIndex": 6,
      "slideLayoutReference": { "layoutId": "<blank layout id>" } } },
  { "createShape": { "objectId": "jr_s07_title", "shapeType": "TEXT_BOX",
      "elementProperties": { "pageObjectId": "jr_s07",
        "size": { "width": { "magnitude": 640, "unit": "PT" },
                  "height": { "magnitude": 50, "unit": "PT" } },
        "transform": { "scaleX": 1, "scaleY": 1,
          "translateX": 40, "translateY": 30, "unit": "PT" } } } },
  { "insertText": { "objectId": "jr_s07_title",
      "text": "Checkout errors fell 40% after the retry fix" } },
  { "updateTextStyle": { "objectId": "jr_s07_title",
      "textRange": { "type": "ALL" },
      "style": { "fontSize": { "magnitude": 28, "unit": "PT" }, "bold": true,
        "foregroundColor": { "opaqueColor": { "themeColor": "DARK1" } } },
      "fields": "fontSize,bold,foregroundColor" } }
]
```

Without `slideLayoutReference`, the slide uses the predefined `BLANK`
layout. Every `updateTextStyle`, `updateParagraphStyle`, and
`updateShapeProperties` request needs `fields`: Google changes only the
fields that it names.

## Slide from a layout, with its placeholders filled

```json
[
  { "createSlide": { "objectId": "jr_s08",
      "slideLayoutReference": { "layoutId": "<title and body layout id>" },
      "placeholderIdMappings": [
        { "layoutPlaceholder": { "type": "TITLE", "index": 0 },
          "objectId": "jr_s08_title" },
        { "layoutPlaceholder": { "type": "BODY", "index": 0 },
          "objectId": "jr_s08_body" } ] } },
  { "insertText": { "objectId": "jr_s08_title", "text": "Three causes" } },
  { "insertText": { "objectId": "jr_s08_body",
      "text": "Retries hid timeouts\nThe cache key had no region\nAlerts fired after 30 min" } }
]
```

Each `\n` starts a new paragraph. Map only placeholders that the layout has: the outline lists their
`type` and `index`. Delete a placeholder that you leave empty with
`deleteObject`.

## Duplicate a slide and replace its text

```json
[
  { "duplicateObject": { "objectId": "<source slide id>",
      "objectIds": { "<source slide id>": "jr_s09",
                     "<source title id>": "jr_s09_title",
                     "<source body id>": "jr_s09_body" } } },
  { "deleteText": { "objectId": "jr_s09_title", "textRange": { "type": "ALL" } } },
  { "insertText": { "objectId": "jr_s09_title", "text": "New title" } }
]
```

The copy goes right after the source slide. Move it with
`updateSlidesPosition`. Send `deleteText` only for a shape that has text.
Check the style of the new text in the thumbnail. For a template with
markers such as `{{title}}`, use `replaceAllText` with `pageObjectIds`, so
that it changes only the slides that you name:

```json
{ "replaceAllText": { "pageObjectIds": ["jr_s09"],
    "containsText": { "text": "{{title}}", "matchCase": true },
    "replaceText": "Q3 results" } }
```

## Text

| Need                  | Request                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------- |
| Bullets               | `createParagraphBullets` with `textRange` and `bulletPreset: "BULLET_DISC_CIRCLE_SQUARE"` |
| Remove bullets        | `deleteParagraphBullets`                                                                  |
| Align, line spacing   | `updateParagraphStyle`: `alignment` (`START`, `CENTER`, `END`), `lineSpacing` (percent)   |
| Space between bullets | `updateParagraphStyle`: `spaceAbove`, `spaceBelow` as pt dimensions                       |
| Vertical alignment    | `updateShapeProperties`: `contentAlignment` (`TOP`, `MIDDLE`, `BOTTOM`)                   |
| Style part of a text  | `textRange: { "type": "FIXED_RANGE", "startIndex": 0, "endIndex": 12 }`                   |
| Link                  | `updateTextStyle` with `style.link.url`                                                   |

- Indexes count UTF-16 code units, from 0, across all paragraphs of the
  shape. Compute them from the text that you insert.
- Google cannot set shrink-on-overflow from the API, and a text edit turns
  it off. Size the box and the font so that the text fits. See
  [design.md](design.md).

## Shapes, color, and order

```json
{ "updateShapeProperties": { "objectId": "jr_s07_card",
    "shapeProperties": {
      "shapeBackgroundFill": { "solidFill": { "color": { "themeColor": "ACCENT1" } } },
      "outline": { "propertyState": "NOT_RENDERED" } },
    "fields": "shapeBackgroundFill.solidFill.color,outline.propertyState" } }
```

- Prefer `themeColor` (`DARK1`, `LIGHT1`, `ACCENT1` to `ACCENT6`) to
  `rgbColor`. Theme colors stay on brand.
- Slide background: `updatePageProperties` with
  `pageProperties.pageBackgroundFill` and
  `fields: "pageBackgroundFill.solidFill.color"`.
- An element that you create later is on top. Change the order with
  `updatePageElementsZOrder` (`BRING_TO_FRONT`, `SEND_TO_BACK`).
- Lines: `createLine` with `category: "STRAIGHT"`, then
  `updateLineProperties`.

## Move or resize

```json
{ "updatePageElementTransform": { "objectId": "jr_s07_title",
    "applyMode": "ABSOLUTE",
    "transform": { "scaleX": 1, "scaleY": 1, "shearX": 0, "shearY": 0,
      "translateX": 40, "translateY": 24, "unit": "PT" } } }
```

`ABSOLUTE` replaces the whole matrix, and a field that you omit becomes 0.
Always send `scaleX` and `scaleY`. No request sets `size` after you create an element: to resize
it, change the scale.

## Tables

`createTable` with `rows`, `columns`, and `elementProperties`. Fill a cell
with `insertText` and `cellLocation: { "rowIndex": 0, "columnIndex": 1 }`.
Style a cell's text with `updateTextStyle` and the same `cellLocation`, and
its fill with `updateTableCellProperties`.

## Images and charts

- `createImage` with `url` and `elementProperties`. The URL must be public,
  at most 2 KB long, and point to a PNG, JPEG, or GIF under 50 MB and 25
  megapixels. When the box has another aspect ratio, Google fits the image
  inside it and keeps the ratio.
- `replaceImage` swaps the picture and keeps the position.
- `createSheetsChart` with `spreadsheetId`, `chartId`, and `linkingMode`
  (`LINKED` or `NOT_LINKED_IMAGE`). The requester must be able to open the
  Sheet.
- Add alt text with `updatePageElementAltText`.

## Speaker notes

The outline gives each slide's `notesPage.notesProperties.speakerNotesObjectId`.
Insert notes with `insertText` into that id. For a slide that you just
created, read the slide to get the id, then add the notes in the next call.

## Slides

- Reorder: `updateSlidesPosition` with `slideObjectIds` in their current
  order and an `insertionIndex` counted before the move.
- Skip a slide in presentation mode: `updateSlideProperties` with
  `slideProperties.isSkipped` and `fields: "isSkipped"`.
- Delete: `deleteObject` with the slide id. Do this only when the requester
  asks.
