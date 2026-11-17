/**
 * Dock-style falloff: 1 at the pointer, easing on a cosine to 0 at `radius`
 * items away. The message outline grows its bars with it, and comfortable
 * Inbox lists scale their cards.
 */
export function dockFalloff(distance: number, radius: number): number {
  return distance < radius
    ? (1 + Math.cos((Math.PI * distance) / radius)) / 2
    : 0;
}
