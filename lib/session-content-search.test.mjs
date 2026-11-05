import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { searchField, CONTENT_WEIGHT } = await jiti.import("./session-search.ts");
const {
  extractTranscriptText,
  transcriptField,
  MAX_CONTENT_CACHE_CHARS,
  MAX_CONTENT_CACHE_ENTRIES,
  MAX_MESSAGE_LINE_BYTES,
  MAX_TRANSCRIPT_CHARS,
} = await jiti.import("./session-content-search.ts");
const { scanJsonlLines } = await jiti.import("./jsonl-lines.ts");

const CHUNK_BYTES = 64 * 1024;
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ompweb-content-search-test-"));
after(() => fs.rm(tmpDir, { recursive: true, force: true }));

let fileCounter = 0;
async function writeTemp(content) {
  const file = path.join(tmpDir, `file-${fileCounter++}.jsonl`);
  await fs.writeFile(file, content);
  return file;
}

/** The pre-streaming implementation (readline over a utf8 stream), kept as the oracle. */
async function referenceExtract(filePath) {
  const parts = [];
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const head = line.slice(0, 400);
      if (!head.includes('"type":"message"') || !(head.includes('"role":"user"') || head.includes('"role":"assistant"'))) continue;
      let content;
      try {
        content = JSON.parse(line)?.message?.content;
      } catch {
        continue;
      }
      if (typeof content === "string") parts.push(content);
      else if (Array.isArray(content)) {
        for (const block of content) if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return parts.join("\n");
}

const message = (role, content, id = "m1") => JSON.stringify({ type: "message", id, parentId: null, message: { role, content } });
const blob = (bytes) => "tool output line ".repeat(Math.ceil(bytes / 17)).slice(0, bytes);

const realistic = [
  JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/work", title: "Demo" }),
  message("user", "first question about caching"),
  message("assistant", [
    { type: "thinking", thinking: "private reasoning" },
    { type: "text", text: "answer part one" },
    { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
    { type: "text", text: "answer part two" },
    { type: "image", data: "AAAA" },
    { type: "text", text: 42 },
    null,
  ]),
  message("toolResult", [{ type: "text", text: "ignored_tool_output" }]),
  JSON.stringify({ type: "custom", data: { role: "user", note: "not a message" } }),
  JSON.stringify({ type: "model_change", model: "x" }),
  message("user", [{ type: "image", data: "BBBB" }, { type: "text", text: "user block text" }]),
  message("user", null),
  message("assistant", 7),
  message("system", "system prompt"),
  message("user", ""),
  message("assistant", [{ type: "text", text: "" }]),
  message("user", "last words"),
].join("\n");

const nonAscii = ["日本語のテスト🙂 café ñandú", "Привет, мир 🚀🚀🚀", "𝒜𝓁𝓅𝒽𝒶 🧪 end"];

/** Lines whose role marker ends near unit 400 of the line, by ASCII and by surrogate-pair padding. */
function headBoundaryLines() {
  const lines = [];
  for (let pad = 330; pad <= 400; pad++) {
    lines.push(`{"type":"message","id":"${"x".repeat(pad)}","message":{"role":"user","content":"ascii pad ${pad}"}}`);
  }
  for (let pairs = 150; pairs <= 200; pairs++) {
    lines.push(`{"type":"message","id":"${"🙂".repeat(pairs)}","message":{"role":"assistant","content":"emoji pad ${pairs}"}}`);
  }
  for (let chars = 340; chars <= 360; chars++) {
    lines.push(`{"type":"message","id":"${"日".repeat(chars)}","message":{"role":"user","content":"cjk pad ${chars}"}}`);
  }
  return lines;
}

const fixtures = {
  "mixed content shapes": realistic + "\n",
  "CRLF line endings": realistic.split("\n").join("\r\n") + "\r\n",
  "missing trailing newline": realistic,
  "missing trailing newline, CRLF": realistic.split("\n").join("\r\n"),
  "empty file": "",
  "only blank lines": "\n\n\r\n\n",
  "invalid JSON and blank lines": [
    message("user", "before"),
    '{"type":"message","message":{"role":"user","content":"cut off',
    "not json at all",
    "",
    '{"type":"message","role":"user"} trailing garbage',
    message("assistant", [{ type: "text", text: "after" }]),
  ].join("\n") + "\n",
  "BOM before first line": "\uFEFF" + message("user", "bom line") + "\n" + message("user", "second") + "\n",
  "multi-byte text": nonAscii.map((text, i) => message(i % 2 ? "assistant" : "user", text)).join("\n") + "\n",
  "huge tool results and unrelated entries": [
    message("user", "needle before"),
    JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: blob(5 << 20) }] } }),
    JSON.stringify({ type: "custom", data: blob(3 << 20) }),
    // The markers appear only far past the head, so the line is rejected.
    JSON.stringify({ type: "custom", pad: "p".repeat(2000), inner: '"type":"message" "role":"user"' }),
    message("assistant", [{ type: "text", text: "needle between" }]),
    JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: blob(4 << 20) }] } }),
    message("user", "needle after"),
  ].join("\n") + "\n",
  "large messages under the cap": [
    message("user", blob(900 * 1024)),
    message("assistant", [{ type: "text", text: blob(300 * 1024) }]),
    message("user", "tail"),
  ].join("\n") + "\n",
  "role marker near the 400 unit head limit": headBoundaryLines().join("\n") + "\n",
};

for (const [name, content] of Object.entries(fixtures)) {
  test(`streaming extraction equals the readline reference: ${name}`, async () => {
    const file = await writeTemp(content);
    assert.equal(await extractTranscriptText(file), await referenceExtract(file));
  });
}

test("extraction keeps user and assistant text blocks in order", async () => {
  const file = await writeTemp(fixtures["mixed content shapes"]);
  assert.equal(
    await extractTranscriptText(file),
    ["first question about caching", "answer part one", "answer part two", "user block text", "", "", "last words"].join("\n"),
  );
});

test("extraction survives every alignment of the message start against the read chunk boundary", async () => {
  for (const eol of ["\n", "\r\n"]) {
    for (let padding = CHUNK_BYTES - 140; padding <= CHUNK_BYTES + 8; padding++) {
      // The filler line plus its eol is `padding` bytes, so the message line starts at that offset.
      const base = JSON.stringify({ type: "custom", pad: "" });
      const filler = JSON.stringify({ type: "custom", pad: "z".repeat(padding - eol.length - Buffer.byteLength(base)) });
      assert.equal(Buffer.byteLength(filler) + eol.length, padding);
      const lines = [filler, message("user", `${nonAscii[0]} ${nonAscii[2]} ${nonAscii[1]}`), message("assistant", nonAscii[1])];
      const file = await writeTemp(lines.join(eol) + eol);
      assert.equal(await extractTranscriptText(file), await referenceExtract(file), `padding ${padding}, eol ${JSON.stringify(eol)}`);
    }
  }
});

test("extraction survives multi-byte characters split by a read chunk boundary", async () => {
  const prefixBytes = Buffer.byteLength(message("user", "").slice(0, -3)); // message line start up to the content's opening quote
  for (let shift = 0; shift < 9; shift++) {
    // The repeated "🙂é日" unit is 9 bytes, so nine shifts put the chunk boundary at every offset within it.
    const pad = "b".repeat(CHUNK_BYTES - prefixBytes - 30 + shift);
    const file = await writeTemp([message("user", `${pad}${"🙂é日".repeat(2000)}`), message("assistant", "tail")].join("\n"));
    assert.equal(await extractTranscriptText(file), await referenceExtract(file), `shift ${shift}`);
  }
});

test("a message line over the cap is skipped and the neighbours survive; a line exactly at the cap is kept", async () => {
  const overhead = Buffer.byteLength(message("user", ""));
  const atCap = message("user", "c".repeat(MAX_MESSAGE_LINE_BYTES - overhead));
  const overCap = message("user", "c".repeat(MAX_MESSAGE_LINE_BYTES - overhead + 1));
  const overCapMultiChunk = message("assistant", [{ type: "text", text: blob(3 * MAX_MESSAGE_LINE_BYTES) }]);
  assert.equal(Buffer.byteLength(atCap), MAX_MESSAGE_LINE_BYTES);
  assert.equal(Buffer.byteLength(overCap), MAX_MESSAGE_LINE_BYTES + 1);

  const neighbours = [message("user", "before"), message("assistant", "after")];
  const withAtCap = await writeTemp([neighbours[0], atCap, neighbours[1]].join("\n") + "\n");
  assert.equal(await extractTranscriptText(withAtCap), await referenceExtract(withAtCap));

  const dropped = await writeTemp([neighbours[0], overCap, overCapMultiChunk, neighbours[1]].join("\n") + "\n");
  const without = await writeTemp(neighbours.join("\n") + "\n");
  assert.equal(await extractTranscriptText(dropped), "before\nafter");
  assert.equal(await extractTranscriptText(dropped), await referenceExtract(without));
});

test("stored transcript text is cut at the character budget and equals the prefix of the full text", async () => {
  const lines = [];
  for (let i = 0; i < 1200; i++) lines.push(message(i % 2 ? "assistant" : "user", `${i} ${"word ".repeat(400)}`));
  const file = await writeTemp(lines.join("\n") + "\n");
  const full = await referenceExtract(file);
  assert.ok(full.length > MAX_TRANSCRIPT_CHARS);
  const text = await extractTranscriptText(file);
  assert.equal(text.length, MAX_TRANSCRIPT_CHARS);
  assert.equal(text, full.slice(0, MAX_TRANSCRIPT_CHARS));

  const underBudget = await writeTemp(lines.slice(0, 100).join("\n") + "\n");
  assert.equal(await extractTranscriptText(underBudget), await referenceExtract(underBudget));
});

test("scanJsonlLines matches a split('\\n') oracle across chunk boundaries, caps and early heads", async () => {
  let seed = 1234;
  const random = (n) => Math.floor(((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * n);
  const lines = [];
  for (let i = 0; i < 6000; i++) {
    const kind = random(40);
    const length = kind === 0 ? 20_000 + random(120_000) : random(300);
    const first = random(3) === 0 ? "a" : "b";
    lines.push(first + (random(5) === 0 ? "é日🙂" : "") + "x".repeat(length));
  }
  const options = { headBytes: 16, maxLineBytes: 50_000 };
  const expected = lines.filter((line) => line.startsWith("a") && Buffer.byteLength(line) <= options.maxLineBytes);
  const seenLengths = new Set();

  for (const [eol, trailing] of [["\n", "\n"], ["\r\n", "\r\n"], ["\n", ""]]) {
    const file = await writeTemp(lines.join(eol) + trailing);
    const got = [];
    await scanJsonlLines(file, {
      ...options,
      accept(buffer, length) {
        seenLengths.add(length);
        return buffer[0] === 0x61;
      },
      onLine: (line) => { got.push(line); },
    });
    assert.deepEqual(got, expected, `eol ${JSON.stringify(eol)} trailing ${JSON.stringify(trailing)}`);
  }
  assert.ok(Math.max(...seenLengths) <= options.headBytes);
});

test("scanJsonlLines stops when onLine returns false and never reports empty lines", async () => {
  const file = await writeTemp("\n\nkeep 1\n\nkeep 2\nkeep 3\n");
  const accepted = [];
  const got = [];
  await scanJsonlLines(file, {
    headBytes: 64,
    maxLineBytes: 1024,
    accept(buffer, length) {
      accepted.push(buffer.toString("utf8", 0, length));
      return true;
    },
    onLine(line) {
      got.push(line);
      return got.length < 2;
    },
  });
  assert.deepEqual(got, ["keep 1", "keep 2"]);
  assert.deepEqual(accepted, ["keep 1", "keep 2"]);
});

test("scanJsonlLines rejects for a file that cannot be read", async () => {
  await assert.rejects(
    scanJsonlLines(path.join(tmpDir, "missing.jsonl"), { headBytes: 8, maxLineBytes: 8, accept: () => true, onLine() {} }),
    { code: "ENOENT" },
  );
});

test("transcriptField extracts user/assistant text and bounds cache with LRU eviction", async () => {
  const fileA = path.join(tmpDir, "session-a.jsonl");
  const fileB = path.join(tmpDir, "session-b.jsonl");
  await fs.writeFile(
    fileA,
    [
      JSON.stringify({ type: "message", message: { role: "user", content: "alpha needle" } }),
      JSON.stringify({ type: "message", message: { role: "toolResult", content: "ignored_tool_output" } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "beta reply" }] } }),
    ].join("\n") + "\n",
  );
  await fs.writeFile(fileB, JSON.stringify({ type: "message", message: { role: "user", content: "gamma query" } }) + "\n");

  const cache = new Map();
  const fieldA = await transcriptField(fileA, cache);
  assert.ok(fieldA);
  assert.equal(fieldA.text.includes("alpha needle"), true);
  assert.equal(fieldA.text.includes("beta reply"), true);
  assert.equal(fieldA.text.includes("ignored_tool_output"), false);

  for (let i = 0; i < MAX_CONTENT_CACHE_ENTRIES - 1; i++) {
    cache.set(path.join(tmpDir, `filler-${i}.jsonl`), {
      version: `1:${i}`,
      chars: 0,
      field: Promise.resolve(searchField(`word${i}`, CONTENT_WEIGHT)),
    });
  }
  assert.equal(cache.size, MAX_CONTENT_CACHE_ENTRIES);

  // Touch fileA via a real cache-hit call so filler-0 becomes the oldest entry.
  await transcriptField(fileA, cache);
  // Adding fileB via transcriptField must evict filler-0 while retaining fileA.
  await transcriptField(fileB, cache);

  assert.equal(cache.size, MAX_CONTENT_CACHE_ENTRIES);
  assert.equal(cache.has(fileA), true);
  assert.equal(cache.has(fileB), true);
  assert.equal(cache.has(path.join(tmpDir, "filler-0.jsonl")), false);
  assert.equal(cache.has(path.join(tmpDir, "filler-1.jsonl")), true);
});

test("transcriptField evicts least recently used entries once the character budget is exceeded", async () => {
  const file = await writeTemp(message("user", "budget probe") + "\n");
  const cache = new Map();
  const half = MAX_CONTENT_CACHE_CHARS / 2;
  for (const name of ["old", "middle"]) {
    cache.set(name, { version: name, chars: half, field: Promise.resolve(searchField(name, CONTENT_WEIGHT)) });
  }
  // Two half-budget entries fit exactly; the new one pushes the total over and evicts the oldest.
  const field = await transcriptField(file, cache);
  assert.ok(field);
  assert.deepEqual([...cache.keys()], ["middle", file]);
  assert.equal(cache.get(file).chars, field.text.length + field.words.reduce((n, word) => n + word.length, 0));
});

test("transcriptField keeps the newest entry even when it alone exceeds the budget", async () => {
  const file = await writeTemp(message("user", "solo") + "\n");
  const cache = new Map([["huge", { version: "huge", chars: MAX_CONTENT_CACHE_CHARS * 2, field: Promise.resolve(searchField("x", CONTENT_WEIGHT)) }]]);
  await transcriptField(file, cache);
  assert.deepEqual([...cache.keys()], [file]);
});

test("transcriptField does not cache an unreadable file", async () => {
  const file = path.join(tmpDir, "vanished.jsonl");
  const cache = new Map();
  assert.equal(await transcriptField(file, cache), null);
  assert.equal(cache.size, 0);
});
