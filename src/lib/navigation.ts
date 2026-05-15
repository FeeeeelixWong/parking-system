/**
 * Returns true only when the current page load is a genuine external navigation
 * (e.g. scanning a QR code). Returns false for reloads, back/forward traversals,
 * and same-origin internal links — none of which should auto-open a gate.
 *
 * Must be called client-side (window must exist).
 */
export function isExternalNavigation(): boolean {
  if (typeof window === "undefined") return false;
  const nav = performance.getEntriesByType("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  if (!nav || nav.type !== "navigate") return false;
  try {
    if (
      document.referrer &&
      new URL(document.referrer).origin === window.location.origin
    )
      return false;
  } catch {}
  return true;
}
