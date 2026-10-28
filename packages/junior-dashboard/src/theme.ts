/** Theme the dashboard shows: the saved choice, or the system color scheme. */
export type DashboardThemeChoice = "dark" | "light" | "system";

/** Browser storage key for the theme choice. No value means `system`. */
export const DASHBOARD_THEME_STORAGE_KEY = "junior-dashboard-theme";

/** Window event that tells the theme script to apply a new saved choice. */
export const DASHBOARD_THEME_CHANGE_EVENT = "junior:dashboard-theme";

/** Browser chrome color for each theme. Dark is the default. */
export const DASHBOARD_THEME_COLORS = {
  dark: "#000000",
  light: "#ffffff",
} as const;

/**
 * Inline head script that sets `data-theme` on `<html>` before first paint.
 * It also follows system color scheme changes, choices from other tabs, and
 * the change event, so it owns every theme update after page load.
 */
export const DASHBOARD_THEME_SCRIPT = `(function () {
  var media = window.matchMedia("(prefers-color-scheme: light)");
  function apply() {
    var choice = null;
    try {
      choice = window.localStorage.getItem(${JSON.stringify(DASHBOARD_THEME_STORAGE_KEY)});
    } catch (_error) {}
    var theme =
      choice === "light" || choice === "dark"
        ? choice
        : media.matches
          ? "light"
          : "dark";
    document.documentElement.dataset.theme = theme;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute(
        "content",
        theme === "light" ? ${JSON.stringify(DASHBOARD_THEME_COLORS.light)} : ${JSON.stringify(DASHBOARD_THEME_COLORS.dark)},
      );
    }
  }
  apply();
  media.addEventListener("change", apply);
  window.addEventListener("storage", function (event) {
    if (event.key === null || event.key === ${JSON.stringify(DASHBOARD_THEME_STORAGE_KEY)}) apply();
  });
  window.addEventListener(${JSON.stringify(DASHBOARD_THEME_CHANGE_EVENT)}, apply);
})();`;
