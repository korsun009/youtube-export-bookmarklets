import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const targets = [
  {
    source: 'youtube-comments-api-exporter-v6/youtube-comments-api-exporter-v6.js',
    output: 'youtube-comments-api-exporter-v6/youtube-comments-api-bookmarklet-v6.txt'
  },
  {
    source: 'youtube-transcript-subtitle-exporter-v3/youtube-transcript-subtitle-exporter-v3.js',
    output: 'youtube-transcript-subtitle-exporter-v3/youtube-transcript-subtitle-bookmarklet-v3.txt'
  }
];

function toOneLine(source) {
  if (/^\s*\/\//m.test(source)) throw new Error('Readable source contains a line comment; safe one-line conversion would change its behavior.');
  return source.split(/\r?\n/).map(line => line.trim()).filter(Boolean).join(' ');
}

export async function buildAll(rootDirectory) {
  const outputs = [];
  for (const target of targets) {
    const sourcePath = path.join(rootDirectory, target.source);
    const outputPath = path.join(rootDirectory, target.output);
    const source = await readFile(sourcePath, 'utf8');
    new Function(source);
    const body = toOneLine(source);
    new Function(body);
    await writeFile(outputPath, `javascript:${body}`, 'utf8');
    outputs.push(outputPath);
  }
  return outputs;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const outputs = await buildAll(root);
  for (const output of outputs) process.stdout.write(`${output}\n`);
}
