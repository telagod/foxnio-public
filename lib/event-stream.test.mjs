import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  DEFAULT_RECONNECT_BACKOFF,
  EVENT_STREAM_CLOSED,
  EVENT_STREAM_CONNECTING,
  EVENT_STREAM_OPEN,
  openResilientEventStream,
  reconnectDelayMs,
} = await jiti.import("./event-stream.ts");

const CHANNEL = { kind: "running" };

/** A stream the test drives by hand, shaped like the multiplexed one. */
class FakeStream {
  constructor(channel) {
    this.channel = channel;
    this.readyState = EVENT_STREAM_CONNECTING;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.closeCalls = 0;
  }
  open() {
    this.readyState = EVENT_STREAM_OPEN;
    this.onopen?.();
  }
  message(data) {
    this.onmessage?.({ data });
  }
  error(readyState) {
    this.readyState = readyState;
    this.onerror?.();
  }
  close() {
    this.closeCalls += 1;
    this.readyState = EVENT_STREAM_CLOSED;
  }
}

function harness(t, options = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const streams = [];
  const frames = [];
  const stop = openResilientEventStream(CHANNEL, (data) => frames.push(data), {
    ...options,
    open: (channel) => {
      const stream = new FakeStream(channel);
      streams.push(stream);
      return stream;
    },
  });
  return { streams, frames, stop, tick: (ms) => t.mock.timers.tick(ms) };
}

test("reconnect delays double from the minimum and stop at the cap", () => {
  const { minMs, maxMs } = DEFAULT_RECONNECT_BACKOFF;
  assert.equal(reconnectDelayMs(0), minMs);
  assert.equal(reconnectDelayMs(1), minMs * 2);
  assert.equal(reconnectDelayMs(2), minMs * 4);
  assert.equal(reconnectDelayMs(50), maxMs);
  assert.equal(reconnectDelayMs(5000), maxMs, "huge failure counts must not overflow past the cap");
  assert.equal(reconnectDelayMs(3, { minMs: 10, maxMs: 1000 }), 80);
});

test("frames are forwarded and a CONNECTING error leaves the stream to reconnect itself", (t) => {
  const { streams, frames, tick } = harness(t);
  streams[0].open();
  streams[0].message("one");
  streams[0].error(EVENT_STREAM_CONNECTING);
  tick(DEFAULT_RECONNECT_BACKOFF.maxMs * 2);
  assert.equal(streams.length, 1, "a recoverable error must not open a second stream");
  assert.equal(streams[0].closeCalls, 0);
  streams[0].open();
  streams[0].message("two");
  assert.deepEqual(frames, ["one", "two"]);
});

test("a CLOSED stream reopens after a doubling delay, and a successful open resets it", (t) => {
  const lost = [];
  const { streams, frames, tick } = harness(t, { onLost: () => lost.push(streams.length) });
  const { minMs } = DEFAULT_RECONNECT_BACKOFF;

  streams[0].error(EVENT_STREAM_CLOSED);
  assert.deepEqual(lost, [1]);
  tick(minMs - 1);
  assert.equal(streams.length, 1, "not before the first delay");
  tick(1);
  assert.equal(streams.length, 2);

  // The reopened stream fails too: the next delay doubles.
  streams[1].error(EVENT_STREAM_CLOSED);
  tick(minMs * 2 - 1);
  assert.equal(streams.length, 2);
  tick(1);
  assert.equal(streams.length, 3);

  // Once a stream really opens, the backoff starts over.
  streams[2].open();
  streams[2].message("alive");
  streams[2].error(EVENT_STREAM_CLOSED);
  tick(minMs);
  assert.equal(streams.length, 4);
  assert.deepEqual(frames, ["alive"]);
  assert.deepEqual(streams.map((stream) => stream.channel), Array(4).fill(CHANNEL));
});

test("a stream that never opens backs off to the cap instead of storming", (t) => {
  const { streams, tick } = harness(t);
  const { maxMs } = DEFAULT_RECONNECT_BACKOFF;
  for (let i = 0; i < 12; i++) {
    streams.at(-1).error(EVENT_STREAM_CLOSED);
    tick(maxMs);
  }
  assert.equal(streams.length, 13);
  streams.at(-1).error(EVENT_STREAM_CLOSED);
  tick(maxMs - 1);
  assert.equal(streams.length, 13, "the delay never drops below the cap once reached");
  tick(1);
  assert.equal(streams.length, 14);
});

test("onOpen fires for the first open and every reopen", (t) => {
  let opens = 0;
  const { streams, tick } = harness(t, { onOpen: () => { opens += 1; } });
  streams[0].open();
  streams[0].error(EVENT_STREAM_CLOSED);
  tick(DEFAULT_RECONNECT_BACKOFF.minMs);
  streams[1].open();
  assert.equal(opens, 2);
});

test("stop closes the live stream", (t) => {
  const { streams, stop } = harness(t);
  streams[0].open();
  stop();
  assert.equal(streams[0].closeCalls, 1);
});

test("stop cancels a pending reopen", (t) => {
  const { streams, stop, tick } = harness(t);
  streams[0].error(EVENT_STREAM_CLOSED);
  stop();
  tick(DEFAULT_RECONNECT_BACKOFF.maxMs * 2);
  assert.equal(streams.length, 1, "no stream may be opened after stop");
});

test("late errors from a stream that was already replaced or stopped are ignored", (t) => {
  const lost = [];
  const { streams, stop, tick } = harness(t, { onLost: () => lost.push(true) });
  streams[0].error(EVENT_STREAM_CLOSED);
  tick(DEFAULT_RECONNECT_BACKOFF.minMs);
  // The first stream reports CLOSED again after its replacement exists.
  streams[0].error(EVENT_STREAM_CLOSED);
  tick(DEFAULT_RECONNECT_BACKOFF.maxMs);
  assert.equal(streams.length, 2);
  assert.deepEqual(lost, [true]);
  stop();
  streams[1].error(EVENT_STREAM_CLOSED);
  assert.deepEqual(lost, [true], "an error delivered after stop must not report a loss");
});
