import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

export async function loadBookmarkletSource(sourcePath) {
  const source = await readFile(sourcePath, 'utf8');
  const testRegistry = {};
  const context = vm.createContext({
    __YT_EXPORTER_TEST__: testRegistry,
    URL,
    Date,
    Intl,
    JSON,
    Math,
    Number,
    String,
    Set,
    Map,
    Array,
    Object,
    RegExp,
    Error,
    DOMException,
    AbortController,
    TextDecoder,
    TextEncoder,
    setTimeout,
    clearTimeout,
    console
  });
  vm.runInContext(source, context, { filename: sourcePath });
  await new Promise(resolve => setImmediate(resolve));
  return { source, registry: testRegistry, context };
}
