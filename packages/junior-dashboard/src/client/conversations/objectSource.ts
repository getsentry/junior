/**
 * Return the plugin to name as the source of an object. Core owns objects of
 * the `junior` plugin, so that id tells the viewer nothing.
 */
export function objectSource(plugin: string): string | undefined {
  return plugin === "junior" ? undefined : plugin;
}
