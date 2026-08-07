/**
 * Trust gate for messages the demo page receives from its viewer iframe.
 *
 * Mirrors isTrustedParentMessage in core/ui/modules/web-api.js. Checking
 * event.source alone is insufficient: an ancestor that frames the demo can
 * navigate the nested viewer iframe to a foreign document without changing
 * the iframe's WindowProxy. The viewer is always served same-origin
 * (/sqlite-viewer/viewer.html), so the browser-verified event.origin must
 * equal the demo page's own origin — which is also the only targetOrigin
 * replies may use.
 */
export function isTrustedViewerMessage(
  event: { source: unknown; origin: string },
  viewerWindow: unknown,
  viewerOrigin: string
): boolean {
  // Reject while the iframe is unmounted so a null event.source can never
  // match a null viewer window.
  if (viewerWindow == null || event.source !== viewerWindow) return false;
  return event.origin === viewerOrigin;
}
