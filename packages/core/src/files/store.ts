import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

/**
 * The bytes of stored files, content-addressed by sha256, in `<storagePath>.files/`.
 * A write fsyncs before returning, so the bytes are durable before the record that
 * names them commits.
 */
export class FileStore {
  private readonly dir: string;

  constructor(storagePath: string) {
    this.dir = `${storagePath}.files`;
  }

  /** Write bytes; returns their sha256 (also the on-disk name). */
  write(bytes: Uint8Array): string {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    mkdirSync(this.dir, { recursive: true });
    const fd = openSync(join(this.dir, sha256), "w");
    try {
      writeSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return sha256;
  }

  read(sha256: string): Uint8Array {
    return readFileSync(join(this.dir, sha256));
  }
}
