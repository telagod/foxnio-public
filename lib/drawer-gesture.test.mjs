import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  RUBBER_BAND_MAX_PX,
  SNAP_VELOCITY_PX_PER_MS,
  classifyMove,
  dragFraction,
  isTap,
  openingVelocity,
  pointerVelocity,
  rubberBand,
  shouldBeOpen,
} = await jiti.import("./drawer-gesture.ts");

test("a move is classified by direction: scroll hands back, wrong way rejects, wobble waits", () => {
  const cases = [
    // [dx, dy, side, mode, verdict]
    [2, 1, "left", "open", "pending"],
    [7, 0, "left", "open", "pending"],
    [9, 2, "left", "open", "claim"],
    [-9, 2, "left", "open", "reject"],
    [9, 2, "left", "close", "reject"],
    [-9, 2, "left", "close", "claim"],
    [-9, 0, "right", "open", "claim"],
    [9, 0, "right", "open", "reject"],
    [9, 0, "right", "close", "claim"],
    [-9, 0, "right", "close", "reject"],
    // Vertical travel is a scroll, however far the finger has also drifted sideways.
    [3, 12, "left", "open", "reject"],
    [11, 12, "left", "open", "reject"],
    // A near-diagonal pull is not decided until one axis dominates.
    [10, 10, "left", "open", "pending"],
    [10, 8, "left", "open", "claim"],
    [0, 0, "left", "open", "pending"],
  ];
  for (const [dx, dy, side, mode, verdict] of cases) {
    assert.equal(classifyMove(dx, dy, side, mode), verdict, `dx=${dx} dy=${dy} ${side} ${mode}`);
  }
});

test("rubber banding is 1:1 at first and never passes its limit", () => {
  assert.equal(rubberBand(0), 0);
  assert.equal(rubberBand(-5), 0);
  assert.ok(Math.abs(rubberBand(1) - 1) < 0.1);
  let previous = 0;
  for (const overshoot of [10, 50, 200, 5000]) {
    const value = rubberBand(overshoot);
    assert.ok(value > previous && value < RUBBER_BAND_MAX_PX, `${overshoot} -> ${value}`);
    previous = value;
  }
});

test("drag fraction follows the finger, clamps at closed and rubber-bands past open", () => {
  assert.equal(dragFraction(false, 0, 300, "left"), 0);
  assert.equal(dragFraction(false, 150, 300, "left"), 0.5);
  assert.equal(dragFraction(false, -80, 300, "left"), 0);
  assert.equal(dragFraction(true, -150, 300, "left"), 0.5);
  assert.equal(dragFraction(true, 0, 300, "left"), 1);
  const past = dragFraction(true, 100, 300, "left");
  assert.ok(past > 1 && past < 1 + RUBBER_BAND_MAX_PX / 300, `rubber ${past}`);
  assert.equal(dragFraction(false, -150, 300, "right"), 0.5);
  assert.equal(dragFraction(true, 150, 300, "right"), 0.5);
  assert.equal(dragFraction(false, 400, 300, "right"), 0);
  // A drawer that cannot be measured stays where it started.
  assert.equal(dragFraction(true, 50, 0, "left"), 1);
  assert.equal(dragFraction(false, 50, Number.NaN, "left"), 0);
});

test("velocity is measured over the last 100 ms only", () => {
  assert.equal(pointerVelocity([]), 0);
  assert.equal(pointerVelocity([{ t: 0, x: 10 }]), 0);
  assert.equal(pointerVelocity([{ t: 5, x: 10 }, { t: 5, x: 40 }]), 0, "no elapsed time");
  assert.equal(pointerVelocity([{ t: 0, x: 0 }, { t: 100, x: 50 }]), 0.5);
  assert.equal(pointerVelocity([{ t: 0, x: 0 }, { t: 100, x: -50 }]), -0.5);
  // The slow start (0 -> 10 over 400 ms) is outside the window; the flick at the end counts.
  const samples = [{ t: 0, x: 0 }, { t: 400, x: 10 }, { t: 450, x: 30 }, { t: 500, x: 60 }];
  assert.equal(pointerVelocity(samples), (60 - 10) / 100);
});

test("opening velocity flips sign for the right-hand drawer", () => {
  assert.equal(openingVelocity(0.5, "left"), 0.5);
  assert.equal(openingVelocity(0.5, "right"), -0.5);
  assert.equal(openingVelocity(-0.5, "right"), 0.5);
});

test("release snaps by velocity first, then by 40% of the travel", () => {
  // Opening from closed.
  assert.equal(shouldBeOpen(false, 0.41, 0), true);
  assert.equal(shouldBeOpen(false, 0.4, 0), false);
  assert.equal(shouldBeOpen(false, 0.1, SNAP_VELOCITY_PX_PER_MS), true, "a flick opens a barely moved drawer");
  assert.equal(shouldBeOpen(false, 0.9, -SNAP_VELOCITY_PX_PER_MS), false, "a flick back closes a mostly open drawer");
  assert.equal(shouldBeOpen(false, 0.1, SNAP_VELOCITY_PX_PER_MS - 0.01), false, "just under the threshold is position only");
  // Closing from open: it must be pushed more than 40% of its width.
  assert.equal(shouldBeOpen(true, 0.6, 0), false);
  assert.equal(shouldBeOpen(true, 0.61, 0), true);
  assert.equal(shouldBeOpen(true, 1.02, 0), true, "rubber-banded past open stays open");
  assert.equal(shouldBeOpen(true, 0.9, -SNAP_VELOCITY_PX_PER_MS), false, "a leftward flick closes");
  assert.equal(shouldBeOpen(true, 0.2, SNAP_VELOCITY_PX_PER_MS), true, "a rightward flick keeps it open");
});

test("a tap is short and nearly still", () => {
  assert.equal(isTap(0, 0, 80), true);
  assert.equal(isTap(6, 6, 120), true);
  assert.equal(isTap(9, 9, 120), false);
  assert.equal(isTap(0, 0, 700), false);
});
