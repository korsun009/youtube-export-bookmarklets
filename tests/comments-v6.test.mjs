import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadBookmarkletSource } from './load-bookmarklet-source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(here, '../youtube-comments-api-exporter-v6/youtube-comments-api-exporter-v6.js');

test('comments v6 exposes its tested core', async () => {
  const { registry } = await loadBookmarkletSource(sourcePath);
  assert.equal(typeof registry.comments, 'object');
  assert.equal(typeof registry.comments.extractVideoId, 'function');
});

test('extractVideoId supports watch, shorts, live, embed and youtu.be URLs', async () => {
  const { registry } = await loadBookmarkletSource(sourcePath);
  const { extractVideoId } = registry.comments;
  assert.equal(extractVideoId('https://www.youtube.com/watch?v=abcdefghijk'), 'abcdefghijk');
  assert.equal(extractVideoId('https://youtube.com/shorts/abcdefghijk?feature=share'), 'abcdefghijk');
  assert.equal(extractVideoId('https://youtube.com/live/abcdefghijk'), 'abcdefghijk');
  assert.equal(extractVideoId('https://youtube.com/embed/abcdefghijk'), 'abcdefghijk');
  assert.equal(extractVideoId('https://youtu.be/abcdefghijk?t=10'), 'abcdefghijk');
  assert.equal(extractVideoId('https://example.com/watch?v=abcdefghijk'), '');
});

test('parseLimit accepts only a whole non-negative decimal integer', async () => {
  const { registry } = await loadBookmarkletSource(sourcePath);
  const { parseLimit } = registry.comments;
  assert.equal(parseLimit('0'), 0);
  assert.equal(parseLimit(' 500 '), 500);
  assert.throws(() => parseLimit('12abc'), /целое число/i);
  assert.throws(() => parseLimit('-1'), /целое число/i);
  assert.throws(() => parseLimit('1.5'), /целое число/i);
});

test('normalizeComment keeps original plain text and identifiers', async () => {
  const { registry } = await loadBookmarkletSource(sourcePath);
  const { normalizeComment } = registry.comments;
  const result = normalizeComment({
    id: 'c1',
    snippet: {
      authorDisplayName: ' Автор ',
      authorChannelUrl: 'https://youtube.com/@author',
      textOriginal: 'Первая\r\nстрока',
      textDisplay: '<b>не использовать</b>',
      likeCount: 7,
      publishedAt: '2026-08-09T00:00:00Z',
      updatedAt: '2026-08-09T00:00:00Z'
    }
  });
  assert.equal(result.id, 'c1');
  assert.equal(result.author, 'Автор');
  assert.equal(result.text, 'Первая\nстрока');
  assert.equal(result.likes, 7);
  assert.deepEqual(Array.from(result.replies), []);
});

test('safeFileName removes Windows-invalid characters and trailing dots', async () => {
  const { registry } = await loadBookmarkletSource(sourcePath);
  const { safeFileName } = registry.comments;
  assert.equal(safeFileName('  A:B/C*D?  .  '), 'A_B_C_D_');
});

test('formatPercent uses Russian decimal comma and tiny-value marker', async () => {
  const { registry } = await loadBookmarkletSource(sourcePath);
  const { formatPercent } = registry.comments;
  assert.equal(formatPercent(100), '100,0%');
  assert.equal(formatPercent(0.005), '<0,01%');
  assert.equal(formatPercent(Number.NaN), '—');
});

const rawComment = (id, parentId = '') => ({
  id,
  snippet: {
    parentId,
    authorDisplayName: `Автор ${id}`,
    textOriginal: `Текст ${id}`,
    likeCount: 0,
    publishedAt: '2026-08-09T00:00:00Z',
    updatedAt: '2026-08-09T00:00:00Z'
  }
});

const rawThread = (id, replyIds = [], expectedReplies = replyIds.length) => ({
  id: `thread-${id}`,
  snippet: { topLevelComment: rawComment(id), totalReplyCount: expectedReplies },
  replies: { comments: replyIds.map(replyId => rawComment(replyId, id)) }
});

test('collectComments de-duplicates embedded replies and loads missing reply pages', async () => {
  const { registry } = await loadBookmarkletSource(sourcePath);
  const calls = [];
  const transport = async (resource, params) => {
    calls.push({ resource, params });
    if (resource === 'commentThreads') {
      return { items: [rawThread('top-1', ['reply-1'], 3)] };
    }
    return { items: [rawComment('reply-1', 'top-1'), rawComment('reply-2', 'top-1'), rawComment('reply-3', 'top-1')] };
  };
  const result = await registry.comments.collectComments({
    videoId: 'abcdefghijk', includeReplies: true, order: 'time', limit: 0, limitMode: 'total'
  }, transport);
  assert.equal(result.records.length, 1);
  assert.deepEqual(Array.from(result.records[0].replies, reply => reply.id), ['reply-1', 'reply-2', 'reply-3']);
  assert.equal(result.diagnostics.duplicateReplies, 1);
  assert.equal(result.diagnostics.replyPages, 1);
  assert.equal(calls.filter(call => call.resource === 'comments').length, 1);
});

test('collectComments applies top-only and total-message limits exactly', async () => {
  const { registry } = await loadBookmarkletSource(sourcePath);
  const page = { items: [rawThread('top-1', ['reply-1', 'reply-2']), rawThread('top-2', ['reply-3'])] };
  const transport = async resource => resource === 'commentThreads' ? page : { items: [] };
  const topLimited = await registry.comments.collectComments({
    videoId: 'abcdefghijk', includeReplies: true, order: 'time', limit: 1, limitMode: 'top'
  }, transport);
  assert.equal(topLimited.records.length, 1);
  assert.equal(topLimited.records[0].replies.length, 2);
  const totalLimited = await registry.comments.collectComments({
    videoId: 'abcdefghijk', includeReplies: true, order: 'time', limit: 2, limitMode: 'total'
  }, transport);
  assert.equal(totalLimited.records.length, 1);
  assert.equal(totalLimited.records[0].replies.length, 1);
});

test('collectComments stops repeated thread and reply page tokens', async () => {
  const { registry } = await loadBookmarkletSource(sourcePath);
  let threadCalls = 0;
  let replyCalls = 0;
  const transport = async resource => {
    if (resource === 'commentThreads') {
      threadCalls += 1;
      return { items: [rawThread(`top-${threadCalls}`, [], 2)], nextPageToken: 'same-thread-token' };
    }
    replyCalls += 1;
    return { items: [rawComment(`reply-${replyCalls}`, 'top-1')], nextPageToken: 'same-reply-token' };
  };
  const result = await registry.comments.collectComments({
    videoId: 'abcdefghijk', includeReplies: true, order: 'time', limit: 0, limitMode: 'total'
  }, transport);
  assert.equal(result.diagnostics.repeatedThreadPageToken, true);
  assert.equal(result.diagnostics.repeatedReplyPageTokens, 2);
  assert.equal(threadCalls, 2);
  assert.equal(replyCalls, 4);
});

test('collectComments returns already collected data when stopped', async () => {
  const { registry } = await loadBookmarkletSource(sourcePath);
  let stopped = false;
  const transport = async () => {
    stopped = true;
    return { items: [rawThread('top-1')], nextPageToken: 'next' };
  };
  const result = await registry.comments.collectComments({
    videoId: 'abcdefghijk', includeReplies: false, order: 'time', limit: 0, limitMode: 'top'
  }, transport, { isStopped: () => stopped });
  assert.equal(result.records.length, 1);
  assert.equal(result.stopped, true);
});

test('collectComments preserves records when an active request is aborted', async () => {
  const { registry } = await loadBookmarkletSource(sourcePath);
  let calls = 0;
  let stopped = false;
  const transport = async () => {
    calls += 1;
    if (calls === 1) return { items: [rawThread('top-1')], nextPageToken: 'next' };
    stopped = true;
    throw new DOMException('Остановлено пользователем', 'AbortError');
  };
  const result = await registry.comments.collectComments({
    videoId: 'abcdefghijk', includeReplies: false, order: 'time', limit: 0, limitMode: 'top'
  }, transport, { isStopped: () => stopped });
  assert.equal(result.records.length, 1);
  assert.equal(result.stopped, true);
  assert.equal(result.error, '');
});

test('requestWithRetry honors Retry-After and succeeds on a later attempt', async () => {
  const { registry } = await loadBookmarkletSource(sourcePath);
  let attempts = 0;
  const waits = [];
  const operation = async () => {
    attempts += 1;
    if (attempts < 3) {
      const error = new Error('temporary');
      error.status = 429;
      error.retryAfter = attempts;
      throw error;
    }
    return 'ok';
  };
  const result = await registry.comments.requestWithRetry(operation, {
    sleep: async ms => waits.push(ms),
    isStopped: () => false,
    maxAttempts: 3
  });
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [1000, 2000]);
});

test('TXT, Markdown, JSON and CSV exports use one model and never contain the API key', async () => {
  const { registry } = await loadBookmarkletSource(sourcePath);
  const model = {
    meta: {
      title: 'Тестовое видео', channel: 'Канал', videoId: 'abcdefghijk',
      canonicalUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
      exportedAt: '2026-08-09T12:00:00.000Z', reportedCommentCount: 3
    },
    settings: { includeReplies: true, order: 'time', limit: 0, limitMode: 'total' },
    diagnostics: { threadPages: 1, replyPages: 1, requestCount: 3 },
    stopped: false,
    error: '',
    records: [{
      ...registry.comments.normalizeComment(rawComment('top-1')),
      author: '=FORMULA',
      text: 'Строка 1\n"Строка 2"',
      replies: [registry.comments.normalizeComment(rawComment('reply-1', 'top-1')), registry.comments.normalizeComment(rawComment('reply-2', 'top-1'))]
    }]
  };
  const txt = registry.comments.buildTextExport(model);
  const markdown = registry.comments.buildMarkdownExport(model);
  const json = registry.comments.buildJsonExport(model);
  const csv = registry.comments.buildCsvExport(model);
  assert.match(txt, /Всего сообщений: 3/);
  assert.match(markdown, /^# Комментарии YouTube/m);
  assert.match(markdown, /## 1\. =FORMULA/);
  assert.match(markdown, /### Ответ 1\.1/);
  assert.match(markdown, /> Строка 1\n> "Строка 2"/);
  assert.match(markdown, /https:\/\/www\.youtube\.com\/watch\?v=abcdefghijk&lc=top-1/);
  assert.equal(JSON.parse(json).counts.total, 3);
  assert.equal((csv.match(/"(?:comment|reply)"/g) || []).length, 3);
  assert.match(csv, /"'=FORMULA"/);
  assert.match(csv, /"Строка 1\n""Строка 2"""/);
  assert.doesNotMatch(`${txt}${markdown}${json}${csv}`, /secret-api-key-123/);
});

test('buildZipBytes creates one UTF-8 ZIP archive with all files and BOM content', async () => {
  const { registry } = await loadBookmarkletSource(sourcePath);
  const bytes = registry.comments.buildZipBytes([
    { filename: 'Комментарии.md', content: '# Привет', mime: 'text/markdown', bom: true },
    { filename: 'comments.json', content: '{"ok":true}', mime: 'application/json', bom: false }
  ]);
  assert.equal(Object.prototype.toString.call(bytes), '[object Uint8Array]');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint32(bytes.length - 22, true), 0x06054b50);
  assert.equal(view.getUint16(bytes.length - 12, true), 2);
  const decoded = new TextDecoder().decode(bytes);
  assert.match(decoded, /Комментарии\.md/);
  assert.match(decoded, /comments\.json/);
  assert.match(decoded, /\uFEFF# Привет/);
});

test('JSON export preserves reply parent identifiers', async () => {
  const { registry } = await loadBookmarkletSource(sourcePath);
  const top = registry.comments.normalizeComment(rawComment('top'));
  top.replies = [registry.comments.normalizeComment(rawComment('reply', 'top'))];
  const json = JSON.parse(registry.comments.buildJsonExport({
    meta: { title: 'Video', videoId: 'abcdefghijk', canonicalUrl: 'https://youtu.be/abcdefghijk', exportedAt: '2026-08-09T00:00:00Z' },
    settings: { includeReplies: true, order: 'time', limit: 0, limitMode: 'total' },
    diagnostics: {}, stopped: false, error: '', records: [top]
  }));
  assert.equal(json.comments[0].replies[0].parentId, 'top');
});

test('comments v6 source is compatible with YouTube Trusted Types and has no system modal UI', async () => {
  const { source, registry } = await loadBookmarkletSource(sourcePath);
  assert.doesNotMatch(source, /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML\s*\(|\bprompt\s*\(|\bconfirm\s*\(|\balert\s*\(/);
  assert.equal(typeof registry.comments.createShell, 'function');
});

test('validateSettings rejects missing key and invalid formats without exposing the key', async () => {
  const { registry } = await loadBookmarkletSource(sourcePath);
  const { validateSettings } = registry.comments;
  assert.throws(() => validateSettings({ apiKey: '', limit: '10', formats: ['txt'] }), /API key/i);
  assert.throws(() => validateSettings({ apiKey: 'secret', limit: '10', formats: [] }), /формат/i);
  const result = validateSettings({
    apiKey: ' secret ', includeReplies: true, order: 'time', limit: '25', limitMode: 'total', formats: ['txt', 'md', 'json'], saveKey: true
  });
  assert.equal(result.apiKey, 'secret');
  assert.equal(result.limit, 25);
  assert.deepEqual(Array.from(result.formats), ['txt', 'md', 'json']);
});
