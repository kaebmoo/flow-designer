import { useCallback, useRef } from "react";

/**
 * Hands focus back to the control that opened an overlay.
 *
 * Needed by dialogs that are *conditionally mounted*: Radix restores focus itself while the
 * dialog stays mounted, but unmounting on close races that restore and focus falls to
 * `<body>`. Call `capture(event.currentTarget)` in the opener's click handler and `restore()`
 * in the close handler.
 */
export function useReturnFocus() {
  const ref = useRef<HTMLElement | null>(null);
  const capture = useCallback((element: HTMLElement) => {
    ref.current = element;
  }, []);
  const restore = useCallback(() => {
    const element = ref.current;
    ref.current = null;
    if (!element) return;
    // Deferred one tick: at close time Radix's focus scope is still mounted and would
    // immediately reclaim a synchronous focus() call; after the dialog unmounts the
    // restore sticks.
    setTimeout(() => element.focus(), 0);
  }, []);
  return { capture, restore };
}
