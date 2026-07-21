import { expect, test } from "bun:test";
import { createGunzip, createUnzip, gzipSync } from "node:zlib";

for (const [name, create] of [
  ["Gunzip", createGunzip],
  ["Unzip", createUnzip],
] as const) {
  test(`${name} remains open for concatenated gzip members`, async () => {
    const first = gzipSync("first member");
    const second = gzipSync("second member");
    const stream = create();
    const chunks: Buffer[] = [];
    let ended = false;

    stream.on("data", chunk => chunks.push(chunk));
    const endPromise = new Promise<void>((resolve, reject) => {
      stream.on("error", reject);
      stream.on("end", () => {
        ended = true;
        resolve();
      });
    });

    stream.write(first);
    await new Promise<void>(resolve => queueMicrotask(resolve));
    expect(ended).toBe(false);

    stream.end(second);
    await endPromise;
    expect(Buffer.concat(chunks).toString()).toBe("first membersecond member");
    expect(stream.bytesWritten).toBe(first.length + second.length);
  });
}
