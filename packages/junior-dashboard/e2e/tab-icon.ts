import { expect, type Page } from "@playwright/test";

/**
 * Name the spots of the tab icon that have the badge's accent fill. Waits
 * for the icon to show a count.
 */
export async function tabIconAccentSpots(page: Page): Promise<string[]> {
  const icon = page.locator('link[rel="icon"]');
  await expect(icon).toHaveAttribute("href", /^data:image\/png;base64,/);
  const href = (await icon.getAttribute("href"))!;
  return page.evaluate(async (src) => {
    const image = new Image();
    image.src = src;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.fillStyle = getComputedStyle(document.documentElement)
      .getPropertyValue("--color-dashboard-accent")
      .trim();
    context.fillRect(0, 0, 1, 1);
    const accent = [...context.getImageData(0, 0, 1, 1).data];
    context.drawImage(image, 0, 0);
    const size = image.width;
    const inset = Math.round(size * 0.16);
    const spots = {
      // The badge's fill right of the count, so the badge stays readable.
      badgeRight: [Math.round(size * 0.42), Math.round(size * 0.24)],
      bottomRight: [size - inset, size - inset],
      // Junior's eye.
      eye: [Math.round(size * 0.6), Math.round(size * 0.4)],
      // The badge's fill left of the count, clear of the glyph.
      topLeft: [Math.round(size * 0.05), Math.round(size * 0.19)],
      topRight: [size - inset, inset],
    };
    return Object.entries(spots)
      .filter(([, [x, y]]) => {
        const pixel = [...context.getImageData(x!, y!, 1, 1).data];
        return pixel.every((value, i) => Math.abs(value - accent[i]!) < 8);
      })
      .map(([name]) => name);
  }, href);
}
