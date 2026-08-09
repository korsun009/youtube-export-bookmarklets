import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildAll } from '../tools/build-bookmarklets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('buildAll creates executable one-line bookmarklets from both readable sources', async () => {
  const outputs = await buildAll(root);
  assert.equal(outputs.length, 2);
  for (const outputPath of outputs) {
    const value = await readFile(outputPath, 'utf8');
    assert.equal(value.startsWith('javascript:'), true);
    assert.equal(value.includes('\n'), false);
    const body = value.slice('javascript:'.length);
    assert.doesNotThrow(() => new Function(body));
  }
});
