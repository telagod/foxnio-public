/** Hold time that opens the context menu on touch. */
export const LONG_PRESS_DELAY_MS = 500;
/** Finger travel that turns a press into a scroll or drag. */
export const LONG_PRESS_SLOP_PX = 8;

export interface LongPressTracker<T> {
  /** Begin tracking a press at (x, y); a previous unfinished press is dropped. */
  start(x: number, y: number, payload: T): void;
  /** Report pointer movement; travel beyond the slop cancels the press. */
  move(x: number, y: number): void;
  /** The press ended or was cancelled before the delay elapsed. */
  cancel(): void;
  /**
   * True once, right after a press fired. The click that follows the finger lifting must then be swallowed;
   * the flag is cleared by this call and by the next `start`.
   */
  consumeFired(): boolean;
}

/** Timing and slop logic of a long press, independent of the DOM so it can be tested with fake timers. */
export function createLongPressTracker<T>(
  onTrigger: (payload: T, x: number, y: number) => void,
  { delay = LONG_PRESS_DELAY_MS, slop = LONG_PRESS_SLOP_PX }: { delay?: number; slop?: number } = {},
): LongPressTracker<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let originX = 0;
  let originY = 0;
  let fired = false;

  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  return {
    start(x, y, payload) {
      clear();
      fired = false;
      originX = x;
      originY = y;
      timer = setTimeout(() => {
        timer = undefined;
        fired = true;
        onTrigger(payload, originX, originY);
      }, delay);
    },
    move(x, y) {
      if (timer !== undefined && Math.hypot(x - originX, y - originY) > slop) clear();
    },
    cancel: clear,
    consumeFired() {
      const result = fired;
      fired = false;
      return result;
    },
  };
}
