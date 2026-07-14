import { Transform } from "node:stream";

/**
 * A pass-through that tallies bytes and aborts the pipeline if it exceeds
 * `maxBytes`. Read `.total` after the stream finishes.
 */
export class ByteCounter extends Transform {
  total = 0;
  constructor(private readonly maxBytes: number) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null, data?: Buffer) => void): void {
    this.total += chunk.length;
    if (this.total > this.maxBytes) {
      cb(new Error("payload_too_large"));
      return;
    }
    cb(null, chunk);
  }
}
