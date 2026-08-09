import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadBookmarkletSource } from './load-bookmarklet-source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(here, '../youtube-transcript-subtitle-exporter-v3/youtube-transcript-subtitle-exporter-v3.js');

test('transcript v3 exposes its tested core', async () => {
  const { registry } = await loadBookmarkletSource(sourcePath);
  assert.equal(typeof registry.transcript, 'object');
  assert.equal(typeof registry.transcript.parseCaptionPayload, 'function');
});

test('decodeHtmlEntities handles named, decimal and hexadecimal entities without a DOM sink', async () => {
  const { registry } = await loadBookmarkletSource(sourcePath);
  const { decodeHtmlEntities } = registry.transcript;
  assert.equal(decodeHtmlEntities('A &amp; B &lt; C &#1040; &#x411; &quot;x&quot; &apos;y&apos;'), 'A & B < C А Б "x" \'y\'');
});

test('parseDisplayedTimestamp supports mm:ss and hh:mm:ss', async () => {
  const { registry } = await loadBookmarkletSource(sourcePath);
  const { parseDisplayedTimestamp } = registry.transcript;
  assert.equal(parseDisplayedTimestamp('00:07'), 7);
  assert.equal(parseDisplayedTimestamp('1:02:03.500'), 3723.5);
  assert.equal(parseDisplayedTimestamp('not time'), null);
});

test('parsePlainTextSegments reads timestamp rows from a transcript panel', async () => {
  const { registry } = await loadBookmarkletSource(sourcePath);
  const cues = registry.transcript.parsePlainTextSegments('Расшифровка видео\n0:00\nПервая строка\n0:07 Вторая строка\n0:16\nТретья строка');
  assert.deepEqual(Array.from(cues, cue => [cue.start, cue.text]), [[0, 'Первая строка'], [7, 'Вторая строка'], [16, 'Третья строка']]);
});

test('parseCaptionPayload reads XML and escaped XML entities', async () => {
  const { registry } = await loadBookmarkletSource(sourcePath);
  const xml = '<transcript><text start="0.5" dur="1.25">A &amp; B</text><text start="1.75" dur="2">C</text></transcript>';
  const cues = registry.transcript.parseCaptionPayload(xml);
  assert.deepEqual(Array.from(cues, cue => [cue.start, cue.duration, cue.text]), [[0.5, 1.25, 'A & B'], [1.75, 2, 'C']]);
  const escaped = '&lt;transcript&gt;&lt;text start=&quot;2&quot; dur=&quot;1&quot;&gt;D &amp;amp; E&lt;/text&gt;&lt;/transcript&gt;';
  assert.equal(registry.transcript.parseCaptionPayload(escaped)[0].text, 'D & E');
});

test('parseCaptionPayload reads srv3 paragraphs and JSON3 events', async () => {
  const { registry } = await loadBookmarkletSource(sourcePath);
  const srv3 = '<timedtext><body><p t="1000" d="2500"><s>Привет </s><s>мир</s></p></body></timedtext>';
  assert.deepEqual(Array.from(registry.transcript.parseCaptionPayload(srv3), cue => [cue.start, cue.duration, cue.text]), [[1, 2.5, 'Привет мир']]);
  const json3 = JSON.stringify({ events: [{ tStartMs: 2000, dDurationMs: 1500, segs: [{ utf8: 'One ' }, { utf8: 'two' }] }] });
  assert.deepEqual(Array.from(registry.transcript.parseCaptionPayload(json3), cue => [cue.start, cue.duration, cue.text]), [[2, 1.5, 'One two']]);
});

test('parseCaptionPayload reads VTT and SRT', async () => {
  const { registry } = await loadBookmarkletSource(sourcePath);
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nVTT text\n';
  const srt = '1\n00:00:03,000 --> 00:00:04,250\nSRT text\n';
  assert.deepEqual(Array.from(registry.transcript.parseCaptionPayload(vtt), cue => [cue.start, cue.duration, cue.text]), [[1, 1.5, 'VTT text']]);
  assert.deepEqual(Array.from(registry.transcript.parseCaptionPayload(srt), cue => [cue.start, cue.duration, cue.text]), [[3, 1.25, 'SRT text']]);
});

test('normalization infers safe ends and subtitle formatters produce valid clocks', async () => {
  const { registry } = await loadBookmarkletSource(sourcePath);
  const cues = registry.transcript.inferAndNormalizeCues([
    { start: 0, duration: 0, text: 'One' },
    { start: 3, duration: 0, text: 'Two' },
    { start: 8, duration: 0, text: 'Three' }
  ], 10);
  assert.deepEqual(Array.from(cues, cue => [cue.start, cue.end]), [[0, 3], [3, 8], [8, 10]]);
  assert.match(registry.transcript.makeSrt(cues), /00:00:00,000 --> 00:00:03,000/);
  assert.match(registry.transcript.makeVtt(cues), /^WEBVTT/);
  assert.equal(registry.transcript.makeTxtBody(cues, false, false), 'One\nTwo\nThree');
});

test('transcript v3 source contains no Trusted Types sinks or system modal UI', async () => {
  const { source, registry } = await loadBookmarkletSource(sourcePath);
  assert.doesNotMatch(source, /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML\s*\(|\bprompt\s*\(|\bconfirm\s*\(|\balert\s*\(/);
  assert.equal(typeof registry.transcript.createShell, 'function');
});

test('mergeTrackCatalog combines alternate URLs for the same language and kind', async () => {
  const { registry } = await loadBookmarkletSource(sourcePath);
  const tracks = registry.transcript.mergeTrackCatalog([
    { sourceLabel: 'WEB', tracks: [{ baseUrl: 'https://x.test/web', languageCode: 'ru', vssId: 'a.ru', kind: 'asr', name: { simpleText: 'Русский' } }] },
    { sourceLabel: 'ANDROID_VR', tracks: [{ baseUrl: 'https://x.test/vr', languageCode: 'ru', vssId: 'a.ru', kind: 'asr', name: { simpleText: 'Русский' } }] }
  ]);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].isGenerated, true);
  assert.deepEqual(Array.from(tracks[0].sources, source => source.sourceLabel), ['WEB', 'ANDROID_VR']);
});

test('fetchTrackCues records failed candidates and returns the first parseable payload', async () => {
  const { registry } = await loadBookmarkletSource(sourcePath);
  const track = {
    name: 'Русский', languageCode: 'ru',
    sources: [{ url: 'https://x.test/bad', sourceLabel: 'WEB' }, { url: 'https://x.test/good', sourceLabel: 'ANDROID_VR' }]
  };
  const fetchFn = async url => {
    if (url.includes('/bad')) return { ok: false, status: 403, text: async () => '' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Готово' }] }] }) };
  };
  const result = await registry.transcript.fetchTrackCues(track, { fetchFn });
  assert.equal(result.cues[0].text, 'Готово');
  assert.equal(result.sourceLabel, 'ANDROID_VR');
  assert.equal(result.attempts.some(attempt => attempt.status === 403), true);
});

test('fetchTrackCues classifies empty and unrecognized responses', async () => {
  const { registry } = await loadBookmarkletSource(sourcePath);
  let call = 0;
  const fetchFn = async () => ({ ok: true, status: 200, text: async () => (++call % 2 ? '' : 'not captions') });
  await assert.rejects(
    registry.transcript.fetchTrackCues({ name: 'x', languageCode: 'x', sources: [{ url: 'https://x.test/one', sourceLabel: 'WEB' }] }, { fetchFn }),
    error => {
      assert.equal(error.attempts.some(attempt => attempt.reason === 'empty'), true);
      assert.equal(error.attempts.some(attempt => attempt.reason === 'unrecognized'), true);
      return true;
    }
  );
});

test('fetchTrackCues aborts before a network request', async () => {
  const { registry } = await loadBookmarkletSource(sourcePath);
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(
    registry.transcript.fetchTrackCues({ sources: [{ url: 'https://x.test/one', sourceLabel: 'WEB' }] }, { signal: controller.signal, fetchFn: async () => { calls += 1; } }),
    error => error.name === 'AbortError'
  );
  assert.equal(calls, 0);
});

test('getCaptionTracksFromResponse reads the player caption renderer', async () => {
  const { registry } = await loadBookmarkletSource(sourcePath);
  const tracks = registry.transcript.getCaptionTracksFromResponse({
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [
      { baseUrl: 'https://x.test/ru', languageCode: 'ru', vssId: 'a.ru', kind: 'asr', name: { runs: [{ text: 'Русский' }] } }
    ] } }
  }, 'WEB');
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].sourceLabel, 'WEB');
});

test('validateSettings requires a source, a format and selected tracks when needed', async () => {
  const { registry } = await loadBookmarkletSource(sourcePath);
  const { validateSettings } = registry.transcript;
  assert.throws(() => validateSettings({ wantTranscript: false, wantTracks: false, formats: ['txt-time'] }), /источник/i);
  assert.throws(() => validateSettings({ wantTranscript: true, wantTracks: false, formats: [] }), /формат/i);
  assert.throws(() => validateSettings({ wantTranscript: false, wantTracks: true, formats: ['vtt'], selectedTrackIndexes: [] }), /дорожк/i);
  const result = validateSettings({ wantTranscript: true, wantTracks: true, formats: ['txt-time', 'srt'], selectedTrackIndexes: [0, 2] });
  assert.deepEqual(Array.from(result.formats), ['txt-time', 'srt']);
  assert.deepEqual(Array.from(result.selectedTrackIndexes), [0, 2]);
});

test('prepareDownloads creates all requested formats with distinct filenames', async () => {
  const { registry } = await loadBookmarkletSource(sourcePath);
  const items = registry.transcript.prepareDownloads({
    baseName: 'Video - Russian',
    type: 'YOUTUBE TRANSCRIPT',
    metadata: { title: 'Video', channel: 'Channel', canonicalUrl: 'https://youtu.be/abcdefghijk' },
    language: 'Русский [ru]',
    trackType: 'Автоматическая',
    sourceMethod: 'test',
    rawCues: [{ text: 'One', start: 0, duration: 1 }],
    videoDuration: 1,
    formats: ['txt-time', 'txt-plain', 'srt', 'vtt'],
    partial: false,
    txtUsesRanges: true,
    date: '2026-08-09'
  });
  assert.equal(items.length, 4);
  assert.deepEqual(Array.from(items, item => item.extension), ['txt', 'txt', 'srt', 'vtt']);
  assert.equal(new Set(items.map(item => item.filename)).size, 4);
  assert.match(items[0].content, /Источник получения: test/);
});

test('buildZipBytes creates a single ZIP containing every transcript file', async () => {
  const { registry } = await loadBookmarkletSource(sourcePath);
  const bytes = registry.transcript.buildZipBytes([
    { filename: 'Расшифровка.txt', content: 'Текст', mime: 'text/plain', bom: true },
    { filename: 'subtitles.srt', content: '1\n00:00:00,000 --> 00:00:01,000\nText\n', mime: 'application/x-subrip', bom: true }
  ]);
  assert.equal(Object.prototype.toString.call(bytes), '[object Uint8Array]');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint32(bytes.length - 22, true), 0x06054b50);
  assert.equal(view.getUint16(bytes.length - 12, true), 2);
  const decoded = new TextDecoder().decode(bytes);
  assert.match(decoded, /Расшифровка\.txt/);
  assert.match(decoded, /subtitles\.srt/);
});
