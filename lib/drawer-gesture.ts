// Pure math for the mobile drawers (left sidebar, right file panel). The hook in
// hooks/useMobileSidebarGestures.ts feeds it pointer coordinates; nothing here
// touches the DOM, so every decision is table-testable.

export type DrawerSide = "left" | "right";
/** "open": the drawer starts closed and is pulled in. "close": it starts open and is pushed out. */
export type DrawerGestureMode = "open" | "close";

/** Travel on one axis before the gesture picks a direction. */
export const CLAIM_SLOP_PX = 8;
/** Release past this share of the drawer width commits the move. */
export const SNAP_POSITION_RATIO = 0.4;
/** A release at or above this speed commits in the direction of travel. */
export const SNAP_VELOCITY_PX_PER_MS = 0.35;
/** Only samples this recent count toward the release velocity. */
export const VELOCITY_WINDOW_MS = 100;
/** The drawer may be pulled at most this far past fully open. */
export const RUBBER_BAND_MAX_PX = 24;
/** A pointer that moves less than this and lifts quickly is a tap. */
export const TAP_SLOP_PX = 10;
export const TAP_MAX_MS = 600;

export type MoveVerdict = "pending" | "claim" | "reject";
export type PointerSample = { t: number; x: number };

/** Left drawers open to the right (+x); right drawers open to the left (-x). */
function openingSign(side: DrawerSide): 1 | -1 {
  return side === "left" ? 1 : -1;
}

/**
 * Decides, from the travel since pointer down, whether the gesture is a drawer
 * drag. Vertical travel hands the touch back to the scroller; travel against
 * the wanted direction rejects it; a near-diagonal wobble stays pending.
 */
export function classifyMove(dx: number, dy: number, side: DrawerSide, mode: DrawerGestureMode): MoveVerdict {
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (ady > CLAIM_SLOP_PX && ady > adx) return "reject";
  if (adx < CLAIM_SLOP_PX || adx <= ady) return "pending";
  const wanted = mode === "open" ? openingSign(side) : -openingSign(side);
  return Math.sign(dx) === wanted ? "claim" : "reject";
}

/** Pull beyond fully open decays toward a hard limit instead of following the finger 1:1. */
export function rubberBand(overshootPx: number, max = RUBBER_BAND_MAX_PX): number {
  if (overshootPx <= 0) return 0;
  return (max * overshootPx) / (overshootPx + max);
}

/**
 * How open the drawer is while dragged: 0 closed, 1 open, slightly above 1
 * while rubber-banding. `dx` is the pointer travel since pointer down.
 */
export function dragFraction(startOpen: boolean, dx: number, drawerWidth: number, side: DrawerSide): number {
  if (!(drawerWidth > 0)) return startOpen ? 1 : 0;
  const raw = (startOpen ? 1 : 0) + (openingSign(side) * dx) / drawerWidth;
  if (raw <= 0) return 0;
  if (raw <= 1) return raw;
  return 1 + rubberBand((raw - 1) * drawerWidth) / drawerWidth;
}

/** Signed pointer velocity (px/ms) over the most recent window; 0 without enough samples. */
export function pointerVelocity(samples: readonly PointerSample[], windowMs = VELOCITY_WINDOW_MS): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  let first = last;
  for (let index = samples.length - 2; index >= 0; index--) {
    if (last.t - samples[index].t > windowMs) break;
    first = samples[index];
  }
  const dt = last.t - first.t;
  return dt > 0 ? (last.x - first.x) / dt : 0;
}

/** Velocity as seen by the drawer: positive means the finger is opening it. */
export function openingVelocity(velocityX: number, side: DrawerSide): number {
  return openingSign(side) * velocityX;
}

/**
 * Release decision. A fast flick wins in its direction; otherwise the drawer
 * must have travelled more than SNAP_POSITION_RATIO of its width from where
 * it started (to open: past 40% open; to close: below 60% open).
 */
export function shouldBeOpen(startOpen: boolean, fraction: number, openingSpeed: number): boolean {
  if (Math.abs(openingSpeed) >= SNAP_VELOCITY_PX_PER_MS) return openingSpeed > 0;
  return startOpen ? fraction > 1 - SNAP_POSITION_RATIO : fraction > SNAP_POSITION_RATIO;
}

/** A short, quick, nearly stationary pointer is a tap. */
export function isTap(dx: number, dy: number, elapsedMs: number): boolean {
  return Math.hypot(dx, dy) < TAP_SLOP_PX && elapsedMs < TAP_MAX_MS;
}
