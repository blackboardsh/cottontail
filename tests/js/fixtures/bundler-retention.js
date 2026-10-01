import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'cottontail-bundle-retention-'));
const entry = join(root, 'entry.ts');
async function build() {
  const result = await Bun.build({ entrypoints: [entry], target: 'bun' });
  if (!result.success || result.outputs.length !== 1) throw new Error('Build failed');
  return (await result.outputs[0].text()).length;
}
async function collect() {
  await new Promise(resolve => setTimeout(resolve, 100));
  Bun.gc(true);
  Bun.gc(true);
}
try {
  writeFileSync(entry, 'export const warmup = 1;');
  await build();
  await collect();
  const before = process.memoryUsage().rss;
  for (let file = 0; file < 8; file++) {
    writeFileSync(join(root, `module${file}.ts`), Array.from({length: 4000}, (_, index) =>
      `export function value${file}_${index}(input: number) { const values = [input, ${index}]; return values[0] + values[1]; }`
    ).join('\n'));
  }
  writeFileSync(entry, Array.from({length: 8}, (_, file) => `export * from './module${file}.ts';`).join('\n'));
  const outputBytes = await build();
  if (outputBytes < 1_000_000) throw new Error('Large graph was not emitted');
  await collect();
  console.log(JSON.stringify({ growth: process.memoryUsage().rss - before, outputBytes }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
