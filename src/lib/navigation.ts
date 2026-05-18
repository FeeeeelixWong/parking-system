/** Detect if page load is a fresh external scan rather than refresh/back/internal navigation. */
export function isExternalNavigation(): boolean {
  if (typeof window === "undefined") return false;

  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (!nav || nav.type !== "navigate") return false;

  try {
    if (document.referrer && new URL(document.referrer).origin === window.location.origin) {
      return false;
    }
  } catch {
    // Invalid referrer URL: treat it as external rather than blocking a real scan.
  }

  return true;
}
