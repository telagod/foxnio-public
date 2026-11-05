import { promises as fs } from "fs";

// Streaming line scanner for large JSONL files. It never builds a string for a
// line the caller does not want: only the first `headBytes` of each line are
// copied (to decide), the rest of an unwanted line is skipped by locating its
// "\n" in the read buffer. Wanted lines are decoded whole, so multi-byte UTF-8
// split across read chunks is always intact. The scan reuses pooled buffers
// instead of allocating a stream and a read buffer per file.

const CHUNK_BYTES = 64 * 1024;
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const MAX_POOLED_SCRATCH = 8;

interface Scratch {
  /** Receives raw file reads. */
  chunk: Buffer;
  /** Holds the line being assembled; grows on demand up to `maxLineBytes`. */
  line: Buffer;
}

const scratchPool: Scratch[] = [];

function acquireScratch(): Scratch {
  return scratchPool.pop() ?? { chunk: Buffer.allocUnsafe(CHUNK_BYTES), line: Buffer.allocUnsafe(CHUNK_BYTES) };
}

function releaseScratch(scratch: Scratch): void {
  // Do not pin a buffer that grew for one oversized line.
  if (scratch.line.length > CHUNK_BYTES) scratch.line = Buffer.allocUnsafe(CHUNK_BYTES);
  if (scratchPool.length < MAX_POOLED_SCRATCH) scratchPool.push(scratch);
}

export interface JsonlScanOptions {
  /** How many leading bytes of a line `accept` gets to see (it sees less for a shorter line). */
  headBytes: number;
  /** A wanted line longer than this is dropped without being decoded. */
  maxLineBytes: number;
  /**
   * Decides from the start of a line whether it is wanted. Only `buffer[0, length)`
   * is valid; the buffer is reused afterwards, so do not keep it.
   */
  accept(buffer: Buffer, length: number): boolean;
  /** Receives each wanted line without its "\n" or "\r\n". Return `false` to stop the scan. */
  onLine(line: string): boolean | void;
}

type LineState = "head" | "keep" | "skip";

class LineScanner {
  private readonly scratch: Scratch;
  private readonly options: JsonlScanOptions;
  private used = 0;
  private state: LineState = "head";

  constructor(scratch: Scratch, options: JsonlScanOptions) {
    this.scratch = scratch;
    this.options = options;
  }

  /** Feeds the next bytes of the file; returns `false` once `onLine` asked to stop. */
  push(data: Buffer): boolean {
    let pos = 0;
    while (pos < data.length) {
      const newline = data.indexOf(NEWLINE, pos);
      const end = newline === -1 ? data.length : newline;
      this.append(data, pos, end);
      if (newline === -1) break;
      if (!this.endLine()) return false;
      pos = newline + 1;
    }
    return true;
  }

  /** Flushes a final line that has no terminating newline. */
  finish(): void {
    if (this.used > 0) this.endLine();
  }

  private append(data: Buffer, from: number, to: number): void {
    if (from === to) return;
    const { headBytes, maxLineBytes } = this.options;
    if (this.state === "head") {
      const take = Math.min(to - from, headBytes - this.used);
      this.copy(data, from, from + take);
      from += take;
      if (from === to) return;
      // The head is complete and the line goes on, so decide now.
      this.state = this.options.accept(this.scratch.line, this.used) ? "keep" : "skip";
    }
    if (this.state === "keep") {
      if (this.used + (to - from) > maxLineBytes) this.state = "skip";
      else this.copy(data, from, to);
    }
  }

  /** Completes the current line; returns `false` when `onLine` asked to stop. */
  private endLine(): boolean {
    const wanted = this.state === "keep" || (this.state === "head" && this.used > 0 && this.options.accept(this.scratch.line, this.used));
    const used = this.used;
    this.used = 0;
    this.state = "head";
    if (!wanted) return true;
    const { line } = this.scratch;
    const end = line[used - 1] === CARRIAGE_RETURN ? used - 1 : used;
    return this.options.onLine(line.toString("utf8", 0, end)) !== false;
  }

  private copy(data: Buffer, from: number, to: number): void {
    const needed = this.used + (to - from);
    const { line } = this.scratch;
    if (needed > line.length) {
      const grown = Buffer.allocUnsafe(Math.min(Math.max(line.length * 2, needed), this.options.maxLineBytes));
      line.copy(grown, 0, 0, this.used);
      this.scratch.line = grown;
    }
    data.copy(this.scratch.line, this.used, from, to);
    this.used = needed;
  }
}

/** Scans `filePath` line by line, delivering only the lines `accept` wants. Rejects if the file cannot be read. */
export async function scanJsonlLines(filePath: string, options: JsonlScanOptions): Promise<void> {
  const file = await fs.open(filePath, "r");
  const scratch = acquireScratch();
  try {
    const scanner = new LineScanner(scratch, options);
    for (;;) {
      const { bytesRead } = await file.read(scratch.chunk, 0, scratch.chunk.length, null);
      if (bytesRead === 0) {
        scanner.finish();
        return;
      }
      if (!scanner.push(scratch.chunk.subarray(0, bytesRead))) return;
    }
  } finally {
    releaseScratch(scratch);
    await file.close();
  }
}
