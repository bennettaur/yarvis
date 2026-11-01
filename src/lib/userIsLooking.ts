/**
 * Whether the user is looking at the window: it has focus and isn't hidden. A
 * window behind another app can still report itself visible, so focus is what
 * tells it apart.
 */
export const userIsLooking = (): boolean =>
  document.hasFocus() && document.visibilityState !== "hidden";
