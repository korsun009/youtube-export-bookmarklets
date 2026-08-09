(async () => {
  'use strict';

  const VERSION = '3.0';
  const RUN_KEY = '__YT_TRANSCRIPT_SUBTITLE_EXPORTER_V3__';
  const SETTINGS_KEY = 'yt-transcript-exporter-settings-v3';
  const MAX_SCROLL_STEPS = 1200;
  const MAX_SCROLL_MS = 90000;
  const SCROLL_WAIT_MS = 140;

  const cleanText = value => String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const cleanCueText = value => cleanText(value).replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim();

  const safeFileName = value => cleanText(value)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .slice(0, 145) || 'YouTube';

  const extractVideoId = value => {
    try {
      const url = new URL(value, 'https://www.youtube.com/');
      const host = url.hostname.replace(/^www\./i, '').toLowerCase();
      if (host === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] || '';
      if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
        const queryId = url.searchParams.get('v');
        if (queryId) return queryId;
        const parts = url.pathname.split('/').filter(Boolean);
        const marker = parts.findIndex(part => ['shorts', 'live', 'embed', 'v'].includes(part));
        if (marker >= 0 && parts[marker + 1]) return parts[marker + 1];
      }
    } catch (_) {}
    return '';
  };

  const decodeHtmlEntities = value => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    return String(value ?? '')
      .replace(/&#x([0-9a-f]+);?/gi, (match, hex) => {
        const code = Number.parseInt(hex, 16);
        try { return Number.isFinite(code) ? String.fromCodePoint(code) : match; } catch (_) { return match; }
      })
      .replace(/&#(\d+);?/g, (match, decimal) => {
        const code = Number.parseInt(decimal, 10);
        try { return Number.isFinite(code) ? String.fromCodePoint(code) : match; } catch (_) { return match; }
      })
      .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] ?? match);
  };

  const TIMESTAMP_TOKEN = /^\s*(\d{1,3}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?\s*$/;
  const TIMESTAMP_PREFIX = /^\s*((?:\d{1,3}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\s+(.+)$/;

  const parseDisplayedTimestamp = value => {
    const text = cleanText(value).replace(/[^0-9:.,]/g, '');
    if (!text) return null;
    const parts = text.replace(',', '.').split(':').map(Number);
    if (parts.some(part => !Number.isFinite(part))) return null;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return null;
  };

  const parsePlainTextSegments = text => {
    const lines = cleanText(text).split('\n').map(cleanText).filter(Boolean);
    const cues = [];
    let index = 0;
    while (index < lines.length) {
      const inline = lines[index].match(TIMESTAMP_PREFIX);
      if (inline) {
        const start = parseDisplayedTimestamp(inline[1]);
        const caption = cleanCueText(inline[2]);
        if (start !== null && caption) cues.push({ text: caption, start, duration: 0, displayedTimestamp: inline[1] });
        index += 1;
        continue;
      }
      if (!TIMESTAMP_TOKEN.test(lines[index])) {
        index += 1;
        continue;
      }
      const start = parseDisplayedTimestamp(lines[index]);
      const parts = [];
      let cursor = index + 1;
      while (cursor < lines.length && !TIMESTAMP_TOKEN.test(lines[cursor]) && !TIMESTAMP_PREFIX.test(lines[cursor])) {
        if (!/^(?:расшифровка видео|расшифровка|transcript|поиск в расшифровке|search in transcript)$/i.test(lines[cursor])) parts.push(lines[cursor]);
        cursor += 1;
      }
      const caption = cleanCueText(parts.join(' '));
      if (start !== null && caption) cues.push({ text: caption, start, duration: 0, displayedTimestamp: lines[index] });
      index = cursor;
    }
    return cues;
  };

  const parseAttributes = value => {
    const attrs = {};
    String(value).replace(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g, (match, name, doubleValue, singleValue) => {
      attrs[name] = decodeHtmlEntities(doubleValue ?? singleValue ?? '');
      return match;
    });
    return attrs;
  };

  const xmlText = value => cleanCueText(decodeHtmlEntities(String(value).replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]+>/g, '')));

  const parseXmlTrack = raw => {
    const source = String(raw);
    const cues = [];
    const textPattern = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
    let match;
    while ((match = textPattern.exec(source))) {
      const attrs = parseAttributes(match[1]);
      const start = Number(attrs.start || 0);
      const duration = Number(attrs.dur || 0);
      const text = xmlText(match[2]);
      if (text && Number.isFinite(start)) cues.push({ text, start, duration: Number.isFinite(duration) ? duration : 0 });
    }
    if (cues.length) return cues;
    const paragraphPattern = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
    while ((match = paragraphPattern.exec(source))) {
      const attrs = parseAttributes(match[1]);
      const start = Number(attrs.t || 0) / 1000;
      const duration = Number(attrs.d || 0) / 1000;
      const text = xmlText(match[2]);
      if (text && Number.isFinite(start)) cues.push({ text, start, duration: Number.isFinite(duration) ? duration : 0 });
    }
    return cues;
  };

  const parseJson3Track = raw => {
    const data = JSON.parse(raw);
    return (Array.isArray(data.events) ? data.events : []).map(event => ({
      text: cleanCueText((event.segs || []).map(segment => segment.utf8 || '').join('')),
      start: Number(event.tStartMs || 0) / 1000,
      duration: Number(event.dDurationMs || 0) / 1000
    })).filter(cue => cue.text && Number.isFinite(cue.start));
  };

  const parseSubtitleBlocks = raw => {
    const blocks = String(raw).replace(/^\uFEFF/, '').replace(/\r/g, '').split(/\n\s*\n/);
    const cues = [];
    for (const block of blocks) {
      const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
      const timingIndex = lines.findIndex(line => line.includes('-->'));
      if (timingIndex < 0) continue;
      const [left, right = ''] = lines[timingIndex].split('-->');
      const start = parseDisplayedTimestamp(left);
      const end = parseDisplayedTimestamp(right.trim().split(/\s+/)[0]);
      const text = cleanCueText(lines.slice(timingIndex + 1).join(' '));
      if (start !== null && end !== null && text) cues.push({ text, start, duration: Math.max(0, end - start) });
    }
    return cues;
  };

  const parseCaptionPayload = raw => {
    let trimmed = String(raw ?? '').trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('&lt;')) trimmed = decodeHtmlEntities(trimmed);
    if (trimmed.startsWith('{')) return parseJson3Track(trimmed);
    if (trimmed.startsWith('<')) return parseXmlTrack(trimmed);
    if (/^WEBVTT/i.test(trimmed) || trimmed.includes('-->')) return parseSubtitleBlocks(trimmed);
    return [];
  };

  const inferAndNormalizeCues = (rawCues, videoDuration = 0) => {
    const sorted = (rawCues || [])
      .filter(cue => cue && cue.text && Number.isFinite(Number(cue.start)))
      .map(cue => ({ text: cleanCueText(cue.text), start: Math.max(0, Number(cue.start)), duration: Math.max(0, Number(cue.duration) || 0) }))
      .sort((a, b) => a.start - b.start || a.text.localeCompare(b.text));
    const deduped = [];
    const seen = new Set();
    for (const cue of sorted) {
      const key = `${Math.round(cue.start * 1000)}|${cue.text}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(cue);
      }
    }
    const positiveGaps = [];
    for (let index = 0; index + 1 < deduped.length; index += 1) {
      const gap = deduped[index + 1].start - deduped[index].start;
      if (gap > 0.1 && gap < 20) positiveGaps.push(gap);
    }
    positiveGaps.sort((a, b) => a - b);
    const median = positiveGaps.length ? positiveGaps[Math.floor(positiveGaps.length / 2)] : 3;
    return deduped.map((cue, index) => {
      const next = deduped[index + 1];
      let duration = cue.duration;
      if (duration <= 0 && next?.start > cue.start) duration = next.start - cue.start;
      if (duration <= 0 && !next && videoDuration > cue.start) duration = Math.min(10, videoDuration - cue.start);
      if (duration <= 0) duration = Math.max(1, Math.min(6, median));
      let end = cue.start + duration;
      if (next?.start > cue.start && end > next.start) end = next.start;
      if (videoDuration > 0) end = Math.min(end, videoDuration);
      if (end <= cue.start) end = cue.start + 0.08;
      return { ...cue, end, duration: end - cue.start };
    });
  };

  const formatClock = (seconds, separator = '.') => {
    const totalMs = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
    const hours = Math.floor(totalMs / 3600000);
    const minutes = Math.floor((totalMs % 3600000) / 60000);
    const secs = Math.floor((totalMs % 60000) / 1000);
    const ms = totalMs % 1000;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}${separator}${String(ms).padStart(3, '0')}`;
  };

  const formatTxtClock = seconds => {
    const full = formatClock(seconds, '.');
    return full.startsWith('00:') ? full.slice(3, -4) : full.slice(0, -4);
  };

  const makeTxtBody = (cues, timestamps, ranges) => cues.map(cue => {
    if (!timestamps) return cue.text;
    return ranges ? `[${formatClock(cue.start)} → ${formatClock(cue.end)}] ${cue.text}` : `[${formatTxtClock(cue.start)}] ${cue.text}`;
  }).join('\n');

  const makeSrt = cues => cues.map((cue, index) => `${index + 1}\n${formatClock(cue.start, ',')} --> ${formatClock(cue.end, ',')}\n${cue.text.replace(/-->/g, '→')}`).join('\n\n') + '\n';

  const makeVtt = cues => `WEBVTT\n\n${cues.map((cue, index) => `${index + 1}\n${formatClock(cue.start)} --> ${formatClock(cue.end)}\n${cue.text.replace(/-->/g, '→')}`).join('\n\n')}\n`;

  const textFromRuns = value => cleanText(value?.simpleText || value?.runs?.map(run => run.text || '').join('') || '');

  const normalizeTrack = (track, sourceLabel) => ({
    languageCode: cleanText(track?.languageCode || 'und'),
    name: textFromRuns(track?.name) || cleanText(track?.languageCode || 'Дорожка'),
    vssId: cleanText(track?.vssId),
    isGenerated: track?.kind === 'asr',
    isTranslatable: Boolean(track?.isTranslatable),
    isDefault: Boolean(track?.isDefault),
    sources: track?.baseUrl ? [{ url: track.baseUrl, sourceLabel }] : []
  });

  const trackIdentity = track => track.vssId || `${track.languageCode}|${track.isGenerated ? 'asr' : 'manual'}|${track.name}`.toLowerCase();

  const mergeTrackCatalog = groups => {
    const catalog = new Map();
    for (const group of groups || []) {
      for (const rawTrack of group.tracks || []) {
        const incoming = normalizeTrack(rawTrack, group.sourceLabel || 'неизвестно');
        const key = trackIdentity(incoming);
        const existing = catalog.get(key);
        if (!existing) {
          catalog.set(key, incoming);
          continue;
        }
        existing.isDefault = existing.isDefault || incoming.isDefault;
        existing.isTranslatable = existing.isTranslatable || incoming.isTranslatable;
        for (const source of incoming.sources) {
          if (!existing.sources.some(item => item.url === source.url)) existing.sources.push(source);
        }
      }
    }
    return [...catalog.values()].map((track, index) => ({ ...track, index }));
  };

  const makeTrackUrls = baseUrl => {
    const candidates = [];
    const add = (url, kind) => {
      if (url && !candidates.some(item => item.url === url)) candidates.push({ url, kind });
    };
    add(baseUrl, 'original');
    try {
      const plain = new URL(baseUrl, 'https://www.youtube.com/');
      plain.searchParams.delete('fmt');
      add(plain.toString(), 'xml');
      for (const format of ['json3', 'srv3', 'vtt']) {
        const url = new URL(plain);
        url.searchParams.set('fmt', format);
        add(url.toString(), format);
      }
    } catch (_) {}
    return candidates;
  };

  const fetchTrackCues = async (track, options = {}) => {
    const fetchFn = options.fetchFn || fetch;
    const signal = options.signal;
    const attempts = [];
    const sources = track?.sources || [];
    if (!sources.length) throw new Error('У дорожки отсутствует URL.');
    for (const source of sources) {
      for (const candidate of makeTrackUrls(source.url)) {
        if (signal?.aborted) throw new DOMException('Остановлено пользователем', 'AbortError');
        try {
          const response = await fetchFn(candidate.url, {
            signal,
            credentials: 'include',
            cache: 'no-store',
            headers: { Accept: 'application/json,text/xml,text/vtt,text/plain,*/*' }
          });
          if (!response.ok) {
            attempts.push({ source: source.sourceLabel, urlKind: candidate.kind, status: response.status, reason: response.status === 403 ? 'forbidden-or-po-token' : 'http' });
            continue;
          }
          const raw = await response.text();
          if (!raw.trim()) {
            attempts.push({ source: source.sourceLabel, urlKind: candidate.kind, status: response.status, reason: 'empty' });
            continue;
          }
          let cues = [];
          try { cues = parseCaptionPayload(raw); }
          catch (error) {
            attempts.push({ source: source.sourceLabel, urlKind: candidate.kind, status: response.status, reason: 'parse-error', detail: cleanText(error?.message || error) });
            continue;
          }
          if (!cues.length) {
            attempts.push({ source: source.sourceLabel, urlKind: candidate.kind, status: response.status, reason: 'unrecognized' });
            continue;
          }
          attempts.push({ source: source.sourceLabel, urlKind: candidate.kind, status: response.status, reason: 'success' });
          return { cues: cues.sort((a, b) => a.start - b.start), sourceLabel: source.sourceLabel, attempts };
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          attempts.push({ source: source.sourceLabel, urlKind: candidate.kind, status: 0, reason: 'network', detail: cleanText(error?.message || error) });
        }
      }
    }
    const error = new Error('Ни один URL дорожки не вернул распознаваемые субтитры.');
    error.attempts = attempts;
    throw error;
  };

  const getCaptionTracksFromResponse = (response, sourceLabel) => {
    const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    return (Array.isArray(tracks) ? tracks : []).map(track => ({ ...track, sourceLabel }));
  };

  const validateSettings = input => {
    const wantTranscript = Boolean(input?.wantTranscript);
    const wantTracks = Boolean(input?.wantTracks);
    if (!wantTranscript && !wantTracks) throw new Error('Выберите хотя бы один источник текста.');
    const formats = [...new Set((input?.formats || []).filter(value => ['txt-time', 'txt-plain', 'srt', 'vtt'].includes(value)))];
    if (!formats.length) throw new Error('Выберите хотя бы один формат файла.');
    const selectedTrackIndexes = [...new Set((input?.selectedTrackIndexes || []).map(Number).filter(Number.isSafeInteger))];
    if (wantTracks && !selectedTrackIndexes.length) throw new Error('Выберите хотя бы одну дорожку субтитров.');
    return { wantTranscript, wantTracks, formats, selectedTrackIndexes };
  };

  const makeTxtHeader = options => [
    options.type,
    '='.repeat(options.type.length),
    `Версия экспортёра: ${VERSION}`,
    `Видео: ${options.metadata.title}`,
    ...(options.metadata.channel ? [`Канал: ${options.metadata.channel}`] : []),
    `URL: ${options.metadata.canonicalUrl}`,
    ...(options.language ? [`Язык: ${options.language}`] : []),
    ...(options.trackType ? [`Тип: ${options.trackType}`] : []),
    ...(options.sourceMethod ? [`Источник получения: ${options.sourceMethod}`] : []),
    `Дата экспорта: ${new Date().toLocaleString('ru-RU')}`,
    `Фрагментов: ${options.cueCount}`,
    `Таймкоды: ${options.timestamps ? 'Да' : 'Нет'}`,
    `Частичная выгрузка: ${options.partial ? 'Да' : 'Нет'}`,
    '',
    '--- ТЕКСТ ---',
    ''
  ].join('\n');

  const prepareDownloads = options => {
    const cues = inferAndNormalizeCues(options.rawCues, options.videoDuration);
    const baseName = safeFileName(options.baseName);
    const date = options.date || new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const items = [];
    const header = timestamps => makeTxtHeader({ ...options, cueCount: cues.length, timestamps });
    for (const format of options.formats || []) {
      if (format === 'txt-time') items.push({ filename: `${baseName} - TXT с таймкодами - ${date}.txt`, extension: 'txt', content: `${header(true)}${makeTxtBody(cues, true, options.txtUsesRanges)}\n`, mime: 'text/plain;charset=utf-8', bom: true });
      if (format === 'txt-plain') items.push({ filename: `${baseName} - TXT без таймкодов - ${date}.txt`, extension: 'txt', content: `${header(false)}${makeTxtBody(cues, false, options.txtUsesRanges)}\n`, mime: 'text/plain;charset=utf-8', bom: true });
      if (format === 'srt') items.push({ filename: `${baseName} - SRT - ${date}.srt`, extension: 'srt', content: makeSrt(cues), mime: 'application/x-subrip;charset=utf-8', bom: false });
      if (format === 'vtt') items.push({ filename: `${baseName} - VTT - ${date}.vtt`, extension: 'vtt', content: makeVtt(cues), mime: 'text/vtt;charset=utf-8', bom: false });
    }
    return items;
  };

  const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
      table[index] = value >>> 0;
    }
    return table;
  })();

  const crc32 = bytes => {
    let crc = 0xFFFFFFFF;
    for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  };

  const concatBytes = parts => {
    const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) { output.set(part, offset); offset += part.length; }
    return output;
  };

  const buildZipBytes = files => {
    if (!Array.isArray(files) || !files.length) throw new Error('Нет файлов для ZIP-архива.');
    if (files.length > 0xFFFF) throw new Error('Слишком много файлов для одного ZIP-архива.');
    const encoder = new TextEncoder();
    const locals = [];
    const centrals = [];
    let localOffset = 0;
    for (const item of files) {
      const name = encoder.encode(safeFileName(item.filename));
      const body = encoder.encode(`${item.bom ? '\uFEFF' : ''}${String(item.content ?? '')}`);
      const checksum = crc32(body);
      const local = new Uint8Array(30 + name.length);
      const localView = new DataView(local.buffer);
      localView.setUint32(0, 0x04034B50, true);
      localView.setUint16(4, 20, true);
      localView.setUint16(6, 0x0800, true);
      localView.setUint16(8, 0, true);
      localView.setUint32(14, checksum, true);
      localView.setUint32(18, body.length, true);
      localView.setUint32(22, body.length, true);
      localView.setUint16(26, name.length, true);
      local.set(name, 30);
      locals.push(local, body);

      const central = new Uint8Array(46 + name.length);
      const centralView = new DataView(central.buffer);
      centralView.setUint32(0, 0x02014B50, true);
      centralView.setUint16(4, 20, true);
      centralView.setUint16(6, 20, true);
      centralView.setUint16(8, 0x0800, true);
      centralView.setUint16(10, 0, true);
      centralView.setUint32(16, checksum, true);
      centralView.setUint32(20, body.length, true);
      centralView.setUint32(24, body.length, true);
      centralView.setUint16(28, name.length, true);
      centralView.setUint32(42, localOffset, true);
      central.set(name, 46);
      centrals.push(central);
      localOffset += local.length + body.length;
    }
    const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054B50, true);
    endView.setUint16(8, files.length, true);
    endView.setUint16(10, files.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, localOffset, true);
    return concatBytes([...locals, ...centrals, end]);
  };

  const getTag = element => (element?.tagName || '').toLowerCase();
  const getId = element => cleanText(element?.id || '').toLowerCase();
  const getClass = element => cleanText(typeof element?.className === 'string' ? element.className : '').toLowerCase();
  const deepText = element => cleanText(element?.innerText || element?.textContent || '');

  const isVisible = element => {
    if (!element || !element.isConnected || element.nodeType !== Node.ELEMENT_NODE) return false;
    try {
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0 && element.getClientRects().length > 0;
    } catch (_) { return false; }
  };

  function* deepElements(root) {
    const stack = [root];
    const seen = new Set();
    while (stack.length) {
      const node = stack.pop();
      if (!node || seen.has(node)) continue;
      seen.add(node);
      if (node.nodeType === Node.ELEMENT_NODE) yield node;
      if (node.shadowRoot) stack.push(node.shadowRoot);
      const children = node.children ? Array.from(node.children) : [];
      for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
    }
  }

  const deepFind = (root, predicate, limit = Infinity) => {
    const result = [];
    for (const element of deepElements(root)) {
      try { if (predicate(element)) result.push(element); } catch (_) {}
      if (result.length >= limit) break;
    }
    return result;
  };

  const timestampCount = text => cleanText(text).split('\n').filter(line => TIMESTAMP_TOKEN.test(line) || TIMESTAMP_PREFIX.test(line)).length;

  const isSegmentRow = element => {
    const tag = getTag(element);
    const cls = getClass(element);
    if (tag.includes('transcript-segment') || cls.includes('transcript-segment')) return true;
    if (element?.getAttribute?.('role') === 'listitem' && timestampCount(deepText(element)) === 1) return true;
    return false;
  };

  const composedParent = node => node?.parentElement || node?.getRootNode?.()?.host || null;

  const rowForNode = node => {
    let current = node;
    for (let depth = 0; current && depth < 12; depth += 1) {
      if (isSegmentRow(current)) return current;
      if (deepText(current).length < 1600 && timestampCount(deepText(current)) === 1) return current;
      current = composedParent(current);
    }
    return node?.parentElement || node;
  };

  const findStartFromData = node => {
    const msValues = [
      node?.getAttribute?.('data-start-time-ms'), node?.getAttribute?.('data-start-ms'),
      node?.dataset?.startTimeMs, node?.dataset?.startMs,
      node?.data?.startMs, node?.data?.startTimeMs,
      node?.data?.transcriptSegmentRenderer?.startMs,
      node?.__data?.data?.startMs, node?.__data?.data?.startTimeMs,
      node?.__data?.data?.transcriptSegmentRenderer?.startMs
    ];
    for (const value of msValues) {
      const number = Number(value);
      if (Number.isFinite(number) && number >= 0) return number / 1000;
    }
    const secondValues = [node?.getAttribute?.('data-start-time'), node?.getAttribute?.('data-start'), node?.dataset?.startTime, node?.dataset?.start];
    for (const value of secondValues) {
      const number = Number(value);
      if (Number.isFinite(number) && number >= 0) return number;
    }
    return null;
  };

  const parseSegmentRow = row => {
    const directTimestamp = row.querySelector?.('.ytwTranscriptSegmentViewModelTimestamp,.segment-timestamp,#timestamp,[class*="segment-time"]');
    const timestampNodes = directTimestamp ? [directTimestamp] : deepFind(row, element => {
      const marker = `${getId(element)} ${getClass(element)}`;
      return (marker.includes('timestamp') || marker.includes('segment-time')) && TIMESTAMP_TOKEN.test(deepText(element));
    }, 20);
    let timestamp = timestampNodes.map(deepText).find(text => TIMESTAMP_TOKEN.test(text)) || deepText(row).split('\n').find(line => TIMESTAMP_TOKEN.test(line)) || '';
    let start = timestamp ? parseDisplayedTimestamp(timestamp) : findStartFromData(row);
    if (start === null) start = findStartFromData(row);
    const directText = row.querySelector?.('.ytAttributedStringHost,.segment-text,#segment-text');
    const textNodes = directText ? [directText] : deepFind(row, element => getClass(element).includes('segment-text') || getId(element) === 'segment-text', 20);
    let text = textNodes.map(deepText).find(value => value && !TIMESTAMP_TOKEN.test(value)) || '';
    if (!text) {
      const aria = cleanText(row?.getAttribute?.('aria-label') || '');
      if (aria) text = aria.replace(/(?:^|\s)(?:\d{1,3}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?(?:\s|$)/, ' ');
    }
    if (!text) text = deepText(row).split('\n').filter(line => !TIMESTAMP_TOKEN.test(line) && !/^(?:расшифровка видео|расшифровка|transcript)$/i.test(line)).join(' ');
    text = cleanCueText(text);
    if (!text || start === null || !Number.isFinite(start)) return null;
    return { text, start, duration: 0, displayedTimestamp: timestamp };
  };

  const collectRows = root => {
    const fastSelector = 'transcript-segment-view-model,yt-transcript-segment-view-model,ytd-transcript-segment-renderer,[class*="transcript-segment"]';
    const rows = new Set(root.querySelectorAll?.(fastSelector) || []);
    if (!rows.size) for (const row of deepFind(root, isSegmentRow, 12000)) rows.add(row);
    if (!rows.size) for (const node of deepFind(root, element => getClass(element).includes('segment-text') || getId(element) === 'segment-text', 12000)) rows.add(rowForNode(node));
    const cues = [];
    for (const row of rows) {
      const cue = parseSegmentRow(row);
      if (cue) cues.push(cue);
    }
    if (!cues.length) cues.push(...parsePlainTextSegments(deepText(root)));
    return cues;
  };

  const queryAcrossOpenRoots = (selector, limit = Infinity) => {
    const matches = [];
    const roots = [document];
    const seenRoots = new Set();
    while (roots.length && matches.length < limit) {
      const root = roots.pop();
      if (!root || seenRoots.has(root)) continue;
      seenRoots.add(root);
      try {
        for (const element of root.querySelectorAll(selector)) {
          matches.push(element);
          if (matches.length >= limit) break;
        }
        for (const element of root.querySelectorAll('*')) if (element.shadowRoot) roots.push(element.shadowRoot);
      } catch (_) {}
    }
    return matches;
  };

  const findTranscriptRoot = () => {
    const candidates = new Set();
    const panelSelector = 'ytd-transcript-renderer,yt-transcript-renderer,[target-id*="transcript"],#segments-container,ytd-engagement-panel-section-list-renderer,yt-engagement-panel-section-list-renderer';
    const segmentSelector = 'transcript-segment-view-model,yt-transcript-segment-view-model,ytd-transcript-segment-renderer,[class*="transcript-segment"],.segment-text';
    for (const element of queryAcrossOpenRoots(panelSelector, 500)) {
      if (element.closest?.('#yttse-v3-backdrop') || !isVisible(element)) continue;
      const tag = getTag(element);
      const targetId = cleanText(element.getAttribute?.('target-id') || '').toLowerCase();
      if (tag.includes('engagement-panel-section-list-renderer') && !targetId.includes('transcript')) {
        const text = deepText(element);
        if (/(?:расшифровка видео|transcript)/i.test(text) && timestampCount(text) >= 2) candidates.add(element);
      } else candidates.add(element);
    }
    const segmentNodes = queryAcrossOpenRoots(segmentSelector, 12000).filter(element => !element.closest?.('#yttse-v3-backdrop') && isVisible(element));
    for (const segment of segmentNodes.slice(0, 120)) {
      let current = segment;
      for (let depth = 0; current && depth < 12; depth += 1) {
        const marker = `${getTag(current)} ${getId(current)} ${getClass(current)} ${cleanText(current.getAttribute?.('target-id') || '')}`.toLowerCase();
        if (marker.includes('transcript') || getId(current) === 'segments-container') candidates.add(current);
        current = composedParent(current);
      }
    }
    if (!candidates.size && segmentNodes.length) {
      const row = rowForNode(segmentNodes[0]);
      if (row?.parentElement) candidates.add(row.parentElement);
    }
    let best = null;
    let bestScore = -Infinity;
    for (const candidate of candidates) {
      const text = deepText(candidate);
      const segmentCount = deepFind(candidate, isSegmentRow, 5000).length;
      let score = segmentCount * 120 + timestampCount(text) * 8;
      if (getId(candidate) === 'segments-container') score += 45;
      if (getTag(candidate).includes('transcript')) score += 80;
      if (text.length > 50 && text.length < 500000) score += 10;
      if (score > bestScore) { best = candidate; bestScore = score; }
    }
    return best;
  };

  const isScrollable = element => {
    if (!element || element === document.body || element === document.documentElement || element === document.scrollingElement) return false;
    if (element.scrollHeight - element.clientHeight < 60) return false;
    try {
      const style = getComputedStyle(element);
      return ['auto', 'scroll', 'overlay'].includes(style.overflowY) || getId(element).includes('scroll') || getId(element) === 'segments-container';
    } catch (_) { return false; }
  };

  const findScroller = root => {
    const candidates = deepFind(root, isScrollable, 2000);
    if (isScrollable(root)) candidates.push(root);
    return candidates.sort((a, b) => {
      const score = element => deepFind(element, isSegmentRow, 5000).length * 20 + timestampCount(deepText(element));
      return score(b) - score(a);
    })[0] || null;
  };

  const collectTranscriptPanel = async (state, onProgress = () => {}) => {
    const root = findTranscriptRoot();
    if (!root) throw new Error('Открытая панель «Расшифровка» не найдена. Откройте её под видео, дождитесь строк текста и повторите запуск.');
    const collected = new Map();
    const collect = () => {
      for (const cue of collectRows(root)) {
        const key = `${Math.round(cue.start * 1000)}|${cue.text}`;
        if (!collected.has(key)) collected.set(key, cue);
      }
    };
    collect();
    const scroller = findScroller(root);
    if (!scroller) {
      for (let attempt = 0; attempt < 12 && !state.cancelled; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 220));
        collect();
      }
    } else {
      const originalTop = scroller.scrollTop;
      const deadline = Date.now() + MAX_SCROLL_MS;
      const seenPositions = new Map();
      let stable = 0;
      try {
        scroller.scrollTop = 0;
        await new Promise(resolve => setTimeout(resolve, 260));
        collect();
        for (let step = 0; step < MAX_SCROLL_STEPS && Date.now() < deadline && !state.cancelled; step += 1) {
          const current = Number(scroller.scrollTop) || 0;
          const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
          const next = Math.min(max, current + Math.max(180, Math.floor(scroller.clientHeight * 0.78)));
          scroller.scrollTop = next;
          await new Promise(resolve => setTimeout(resolve, SCROLL_WAIT_MS));
          const before = collected.size;
          collect();
          const positionKey = `${Math.round(scroller.scrollTop)}|${Math.round(scroller.scrollHeight)}|${collected.size}`;
          seenPositions.set(positionKey, (seenPositions.get(positionKey) || 0) + 1);
          const atBottom = scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 3;
          stable = atBottom && collected.size === before ? stable + 1 : 0;
          onProgress({ count: collected.size, step: step + 1 });
          if (stable >= 6 || seenPositions.get(positionKey) >= 8) break;
        }
      } finally { scroller.scrollTop = originalTop; }
    }
    const cues = [...collected.values()].sort((a, b) => a.start - b.start || a.text.localeCompare(b.text));
    if (!cues.length) throw new Error('Панель найдена, но ни одной строки расшифровки прочитать не удалось.');
    return { cues, partial: Boolean(state.cancelled), scrollerFound: Boolean(scroller), rootTag: getTag(root) };
  };

  const parseMaybeJson = value => {
    if (!value) return null;
    if (typeof value === 'object') return value;
    if (typeof value !== 'string') return null;
    try { return JSON.parse(value); } catch (_) { return null; }
  };

  const unwrapPlayerResponse = candidate => {
    const parsed = parseMaybeJson(candidate);
    return parsed ? parseMaybeJson(parsed.playerResponse) || parseMaybeJson(parsed.response) || parsed : null;
  };

  const getWebPlayerResponse = videoId => {
    const candidates = [];
    try {
      const player = document.getElementById('movie_player');
      if (typeof player?.getPlayerResponse === 'function') candidates.push(player.getPlayerResponse());
    } catch (_) {}
    candidates.push(window.ytInitialPlayerResponse, window.ytplayer?.config?.args?.player_response, window.ytplayer?.bootstrapPlayerResponse, document.querySelector('ytd-watch-flexy')?.playerData, document.querySelector('ytd-watch-flexy')?.data?.playerResponse);
    for (const candidate of candidates) {
      const response = unwrapPlayerResponse(candidate);
      if (response && (response.videoDetails?.videoId === videoId || response.microformat?.playerMicroformatRenderer?.externalVideoId === videoId)) return response;
    }
    return null;
  };

  const getYtCfg = key => {
    try {
      const value = window.ytcfg?.get?.(key) ?? window.ytcfg?.data_?.[key];
      return value === undefined || value === null ? '' : value;
    } catch (_) { return ''; }
  };

  const requestPlayerProfile = async (apiKey, videoId, profile, signal) => {
    const visitorData = cleanText(getYtCfg('VISITOR_DATA'));
    const client = {
      clientName: profile.clientName,
      clientVersion: profile.clientVersion,
      hl: cleanText(getYtCfg('HL') || document.documentElement.lang || 'ru').split('-')[0],
      gl: cleanText(getYtCfg('GL') || 'RU').toUpperCase(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      utcOffsetMinutes: -new Date().getTimezoneOffset()
    };
    Object.assign(client, profile.extraClient || {});
    if (visitorData) client.visitorData = visitorData;
    const headers = { 'Content-Type': 'application/json', 'X-Youtube-Client-Name': String(profile.clientNameId), 'X-Youtube-Client-Version': profile.clientVersion };
    if (visitorData) headers['X-Goog-Visitor-Id'] = visitorData;
    const response = await fetch(`/youtubei/v1/player?key=${encodeURIComponent(apiKey)}&prettyPrint=false`, {
      method: 'POST', credentials: profile.credentials || 'omit', cache: 'no-store', signal, headers,
      body: JSON.stringify({ context: { client, ...(profile.thirdParty ? { thirdParty: profile.thirdParty } : {}) }, videoId, contentCheckOk: true, racyCheckOk: true })
    });
    if (!response.ok) throw new Error(`${profile.label}: HTTP ${response.status}`);
    return response.json();
  };

  const getTrackCatalog = async (videoId, signal, onProgress = () => {}) => {
    const groups = [];
    const errors = [];
    let preferredResponse = getWebPlayerResponse(videoId);
    const webTracks = getCaptionTracksFromResponse(preferredResponse, 'WEB player');
    if (webTracks.length) groups.push({ sourceLabel: 'WEB player', tracks: webTracks });
    const apiKey = cleanText(getYtCfg('INNERTUBE_API_KEY'));
    const webVersion = cleanText(getYtCfg('INNERTUBE_CONTEXT_CLIENT_VERSION'));
    const webName = cleanText(getYtCfg('INNERTUBE_CLIENT_NAME') || 'WEB');
    const webNameId = Number(getYtCfg('INNERTUBE_CONTEXT_CLIENT_NAME')) || 1;
    const profiles = [];
    if (apiKey && webVersion) {
      profiles.push({ label: `Текущий ${webName} ${webVersion}`, clientName: webName, clientNameId: webNameId, clientVersion: webVersion, credentials: 'include' });
      profiles.push({ label: `WEB_EMBEDDED ${webVersion}`, clientName: 'WEB_EMBEDDED_PLAYER', clientNameId: 56, clientVersion: webVersion, credentials: 'omit', thirdParty: { embedUrl: `https://www.youtube.com/embed/${videoId}` } });
    }
    if (apiKey) profiles.push({ label: 'ANDROID_VR fallback', clientName: 'ANDROID_VR', clientNameId: 28, clientVersion: '1.65.10', credentials: 'omit', extraClient: { androidSdkVersion: 32, osName: 'Android', osVersion: '12L', deviceMake: 'Oculus', deviceModel: 'Quest 3' } });
    for (const [index, profile] of profiles.entries()) {
      if (signal?.aborted) throw new DOMException('Остановлено пользователем', 'AbortError');
      onProgress({ index, total: profiles.length, label: profile.label });
      try {
        const response = await requestPlayerProfile(apiKey, videoId, profile, signal);
        const tracks = getCaptionTracksFromResponse(response, profile.label);
        if (tracks.length) {
          groups.push({ sourceLabel: profile.label, tracks });
          if (!preferredResponse) preferredResponse = response;
        } else errors.push(`${profile.label}: дорожки не найдены`);
      } catch (error) { errors.push(cleanText(error?.message || error)); }
    }
    const tracks = mergeTrackCatalog(groups);
    if (!tracks.length) throw new Error(`YouTube не отдал список дорожек.${errors.length ? `\n\n${errors.join('\n')}` : ''}`);
    return { tracks, playerResponse: preferredResponse, errors, sources: [...new Set(groups.map(group => group.sourceLabel))] };
  };

  const el = (tag, options = {}, children = []) => {
    const node = document.createElement(tag);
    if (options.text !== undefined) node.textContent = String(options.text);
    if (options.className) node.className = options.className;
    for (const [name, value] of Object.entries(options.attrs || {})) if (value !== undefined && value !== null) node.setAttribute(name, String(value));
    Object.assign(node.style, options.style || {});
    for (const [name, handler] of Object.entries(options.on || {})) node.addEventListener(name, handler);
    for (const child of (Array.isArray(children) ? children : [children])) if (child) node.append(child);
    return node;
  };

  const createShell = () => {
    const previousFocus = document.activeElement;
    const style = el('style', { text: `
#yttse-v3-backdrop{position:fixed;inset:0;z-index:2147483646;display:grid;place-items:center;padding:18px;background:radial-gradient(circle at 18% 8%,rgba(49,199,211,.2),transparent 36%),rgba(3,7,10,.86);backdrop-filter:blur(8px);font-family:"Segoe UI Variable Text","Trebuchet MS",sans-serif;color:#edf8f8}#yttse-v3-panel{width:min(720px,96vw);max-height:92vh;overflow:auto;box-sizing:border-box;padding:24px;background:linear-gradient(155deg,#111c21 0%,#081015 65%,#10191b 100%);border:1px solid rgba(111,224,229,.36);border-radius:20px;box-shadow:0 30px 100px rgba(0,0,0,.72),inset 0 1px rgba(255,255,255,.06)}#yttse-v3-panel *{box-sizing:border-box}#yttse-v3-panel h2{margin:0;font:650 29px/1.08 Georgia,"Times New Roman",serif;letter-spacing:-.025em}#yttse-v3-panel p{margin:7px 0 0;color:#a9bcc0;line-height:1.5}.ytt-kicker{color:#78dce2;font:750 11px/1.2 ui-monospace,Consolas,monospace;letter-spacing:.18em;text-transform:uppercase}.ytt-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:18px}.ytt-card{padding:14px;border:1px solid #2d444a;border-radius:13px;background:rgba(255,255,255,.025)}.ytt-wide{grid-column:1/-1}.ytt-label{display:block;margin-bottom:8px;color:#dcebed;font-size:13px;font-weight:750}.ytt-checks{display:flex;flex-wrap:wrap;gap:9px 15px}.ytt-check{display:flex;align-items:flex-start;gap:7px;color:#d5e4e6}.ytt-hint{margin-top:8px;color:#8fa5aa;font-size:12px;line-height:1.45}.ytt-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:9px;margin-top:18px}.ytt-btn{border:0;border-radius:10px;padding:10px 15px;cursor:pointer;font-weight:780;background:#26383d;color:#eef8f9}.ytt-btn:hover{filter:brightness(1.12)}.ytt-btn:disabled{cursor:default;opacity:.55}.ytt-primary{background:#78dce2;color:#061014;box-shadow:0 9px 28px rgba(42,180,194,.23)}.ytt-danger{background:#7b292b;color:#fff}.ytt-error,.ytt-warning{margin-top:12px;padding:10px 12px;border-radius:10px;white-space:pre-line}.ytt-error{border:1px solid #8e4243;background:rgba(139,43,45,.18);color:#ffc5c5}.ytt-warning{border:1px solid #85691d;background:rgba(134,99,19,.15);color:#ffe19a}.ytt-tracks{display:grid;gap:7px;max-height:31vh;overflow:auto;margin-top:10px;padding-right:4px}.ytt-track{padding:9px;border:1px solid #314b51;border-radius:9px;background:#0b1519}.ytt-progress{height:7px;overflow:hidden;border-radius:99px;background:#1e3035;margin:18px 0}.ytt-progress span{display:block;height:100%;width:9%;border-radius:inherit;background:linear-gradient(90deg,#55c9d2,#b4f2e1);transition:width .25s}.ytt-muted{color:#93a8ad;white-space:pre-line;line-height:1.55}.ytt-files{display:grid;gap:8px;margin-top:14px}.ytt-file{width:100%;text-align:left;word-break:break-word}@media(max-width:620px){#yttse-v3-panel{padding:18px}.ytt-grid{grid-template-columns:1fr}.ytt-wide{grid-column:auto}}
` });
    const backdrop = el('div', { attrs: { id: 'yttse-v3-backdrop' } });
    const panel = el('section', { attrs: { id: 'yttse-v3-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Экспорт расшифровки YouTube', tabindex: '-1' } });
    const content = el('div');
    panel.append(content);
    backdrop.append(panel);
    document.documentElement.append(style, backdrop);
    const close = () => {
      backdrop.remove();
      style.remove();
      previousFocus?.focus?.();
    };
    backdrop.addEventListener('keydown', event => {
      if (event.key === 'Escape' && backdrop.dataset.locked !== 'true') close();
    });
    queueMicrotask(() => panel.focus());
    return { backdrop, panel, content, close, focus: () => panel.focus() };
  };

  const heading = (title, subtitle) => el('div', {}, [
    el('div', { className: 'ytt-kicker', text: `YouTube text archive · v${VERSION}` }),
    el('h2', { text: title }),
    el('p', { text: subtitle })
  ]);

  const button = (text, kind = '', handler = null) => el('button', { className: `ytt-btn ${kind}`.trim(), attrs: { type: 'button' }, text, on: handler ? { click: handler } : {} });

  const check = (name, text, checked = false) => {
    const input = el('input', { attrs: { type: 'checkbox', name } });
    input.checked = checked;
    return { input, label: el('label', { className: 'ytt-check' }, [input, el('span', { text })]) };
  };

  const renderSettings = (shell, defaults, loadCatalog) => new Promise(resolve => {
    shell.backdrop.dataset.locked = 'false';
    const transcript = check('source-transcript', 'Расшифровка из уже открытой панели YouTube', defaults.wantTranscript !== false);
    const tracks = check('source-tracks', 'Дорожки субтитров (одна, несколько или все)', defaults.wantTracks === true);
    const formatDefs = [
      ['txt-time', 'TXT с таймкодами'], ['txt-plain', 'TXT без таймкодов'], ['srt', 'SRT для проигрывателей'], ['vtt', 'VTT для веб-видео']
    ];
    const formats = formatDefs.map(([id, label]) => check(`format-${id}`, label, (defaults.formats || ['txt-time']).includes(id)));
    const errorBox = el('div', { className: 'ytt-error', attrs: { hidden: 'hidden', role: 'alert' } });
    const trackArea = el('div', { className: 'ytt-tracks' });
    const catalogInfo = el('div', { className: 'ytt-hint', text: 'Нажмите «Найти дорожки», чтобы увидеть доступные языки.' });
    let catalog = null;
    let trackChecks = [];
    let loadButton;
    const performLoad = async () => {
      loadButton.disabled = true;
      loadButton.textContent = 'Получаю список…';
      errorBox.hidden = true;
      try {
        catalog = await loadCatalog(status => { catalogInfo.textContent = status; });
        tracks.input.checked = true;
        trackArea.replaceChildren();
        trackChecks = catalog.tracks.map((track, index) => {
          const flags = [track.isGenerated ? 'автоматическая' : 'ручная/добавленная', track.isDefault ? 'по умолчанию' : '', track.isTranslatable ? 'переводимая' : ''].filter(Boolean).join(', ');
          const item = check(`track-${index}`, `${track.name} [${track.languageCode}] — ${flags}`, index === 0 || track.isDefault);
          trackArea.append(el('div', { className: 'ytt-track' }, item.label));
          return item;
        });
        catalogInfo.textContent = `Найдено дорожек: ${catalog.tracks.length}. Источники списка: ${catalog.sources.join(', ')}.`;
        loadButton.textContent = 'Обновить список дорожек';
      } catch (error) {
        catalogInfo.textContent = 'Список дорожек получить не удалось.';
        errorBox.textContent = error.message || String(error);
        errorBox.hidden = false;
        loadButton.textContent = 'Повторить поиск дорожек';
      } finally { loadButton.disabled = false; }
    };
    loadButton = button('Найти дорожки', '', performLoad);
    const grid = el('div', { className: 'ytt-grid' }, [
      el('div', { className: 'ytt-card ytt-wide' }, [el('div', { className: 'ytt-label', text: 'Что сохранить' }), el('div', { className: 'ytt-checks' }, [transcript.label, tracks.label]), el('div', { className: 'ytt-hint', text: 'Для первого источника заранее откройте «Показать расшифровку». Скрипт не нажимает кнопки YouTube.' })]),
      el('div', { className: 'ytt-card ytt-wide' }, [el('div', { className: 'ytt-label', text: 'Форматы' }), el('div', { className: 'ytt-checks' }, formats.map(item => item.label))]),
      el('div', { className: 'ytt-card ytt-wide' }, [el('div', { className: 'ytt-label', text: 'Дорожки субтитров' }), loadButton, catalogInfo, trackArea])
    ]);
    const cancel = button('Отмена', '', () => { shell.close(); resolve(null); });
    const start = button('Подготовить файлы', 'ytt-primary', async () => {
      try {
        if (tracks.input.checked && !catalog) {
          await performLoad();
          return;
        }
        const settings = validateSettings({
          wantTranscript: transcript.input.checked,
          wantTracks: tracks.input.checked,
          formats: formats.filter(item => item.input.checked).map(item => item.input.name.replace('format-', '')),
          selectedTrackIndexes: trackChecks.map((item, index) => item.input.checked ? index : -1).filter(index => index >= 0)
        });
        errorBox.hidden = true;
        resolve({ settings, catalog });
      } catch (error) {
        errorBox.textContent = error.message || String(error);
        errorBox.hidden = false;
      }
    });
    shell.content.replaceChildren(heading('Расшифровка и субтитры', 'Текст остаётся в браузере. Выберите источники и форматы на одном экране.'), grid, errorBox, el('div', { className: 'ytt-actions' }, [cancel, start]));
  });

  const renderProgress = (shell, stopAction) => {
    shell.backdrop.dataset.locked = 'true';
    const stage = el('p', { className: 'ytt-muted', text: 'Подготовка…' });
    const detail = el('div', { className: 'ytt-muted' });
    const bar = el('span');
    const stop = button('Остановить и сохранить подготовленное', 'ytt-danger', () => {
      stop.disabled = true;
      stop.textContent = 'Остановка запрошена…';
      stopAction();
    });
    shell.content.replaceChildren(heading('Идёт подготовка файлов', 'Прокрутка ограничена панелью расшифровки, количеством шагов и временем.'), stage, el('div', { className: 'ytt-progress' }, bar), detail, el('div', { className: 'ytt-actions' }, stop));
    return { update(data = {}) { stage.textContent = data.stage || stage.textContent; detail.textContent = data.detail || ''; bar.style.width = `${Math.max(3, Math.min(100, Number(data.percent) || 9))}%`; } };
  };

  const triggerDownload = item => {
    const blob = new Blob(item.bom ? ['\uFEFF', item.content] : [item.content], { type: item.mime });
    const url = URL.createObjectURL(blob);
    const anchor = el('a', { attrs: { href: url, download: item.filename } });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const triggerZipDownload = files => {
    const date = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const title = safeFileName(document.title.replace(/\s*-\s*YouTube\s*$/i, '') || 'YouTube');
    const url = URL.createObjectURL(new Blob([buildZipBytes(files)], { type: 'application/zip' }));
    const anchor = el('a', { attrs: { href: url, download: `${title} - transcript and subtitles - ${date}.zip` } });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const renderResult = (shell, files, warnings, stopped) => {
    shell.backdrop.dataset.locked = 'false';
    const list = el('div', { className: 'ytt-files' });
    for (const item of files) list.append(button(item.filename, 'ytt-file', () => triggerDownload(item)));
    const all = button(`Скачать всё ZIP (${files.length})`, 'ytt-primary', () => triggerZipDownload(files));
    shell.content.replaceChildren(
      heading(stopped ? 'Частичный результат подготовлен' : 'Файлы подготовлены', `Файлов: ${files.length}. Их можно скачать вместе или по одному.`),
      ...(warnings.length ? [el('div', { className: 'ytt-warning', text: warnings.join('\n\n') })] : []),
      list,
      el('div', { className: 'ytt-actions' }, [button('Закрыть', '', () => shell.close()), all])
    );
  };

  const renderError = (shell, title, message) => {
    shell.backdrop.dataset.locked = 'false';
    shell.content.replaceChildren(heading(title, 'Страница YouTube не изменена; сторонние серверы не использовались.'), el('div', { className: 'ytt-error', text: message, attrs: { role: 'alert' } }), el('div', { className: 'ytt-actions' }, button('Закрыть', 'ytt-primary', () => shell.close())));
  };

  const getMetadata = (response, videoId) => {
    const player = document.getElementById('movie_player');
    let videoData = {};
    try { videoData = player?.getVideoData?.() || {}; } catch (_) {}
    return {
      title: cleanText(response?.videoDetails?.title || videoData.title || document.title.replace(/\s*-\s*YouTube\s*$/i, '')) || 'YouTube video',
      channel: cleanText(response?.videoDetails?.author || videoData.author || ''),
      duration: Number(response?.videoDetails?.lengthSeconds || player?.getDuration?.() || 0) || 0,
      canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`
    };
  };

  const detectTranscriptLanguage = () => {
    try {
      const track = document.getElementById('movie_player')?.getOption?.('captions', 'track');
      const name = textFromRuns(track?.name) || cleanText(track?.displayName || track?.languageName || '');
      const code = cleanText(track?.languageCode || '');
      if (name || code) return `${name || code}${code && name !== code ? ` [${code}]` : ''}`;
    } catch (_) {}
    return 'текущая дорожка панели';
  };

  const testedCore = {
    VERSION,
    cleanText,
    cleanCueText,
    safeFileName,
    extractVideoId,
    decodeHtmlEntities,
    parseDisplayedTimestamp,
    parsePlainTextSegments,
    parseXmlTrack,
    parseJson3Track,
    parseCaptionPayload,
    inferAndNormalizeCues,
    makeTxtBody,
    makeSrt,
    makeVtt,
    mergeTrackCatalog,
    fetchTrackCues,
    getCaptionTracksFromResponse,
    validateSettings,
    prepareDownloads,
    buildZipBytes,
    queryAcrossOpenRoots,
    findTranscriptRoot,
    findScroller,
    collectTranscriptPanel,
    createShell
  };

  if (globalThis.__YT_EXPORTER_TEST__) {
    globalThis.__YT_EXPORTER_TEST__.transcript = testedCore;
    return;
  }

  if (window[RUN_KEY]?.focus) {
    window[RUN_KEY].focus();
    return;
  }

  const shell = createShell();
  const state = { cancelled: false };
  let controller = new AbortController();
  const originalClose = shell.close;
  shell.close = () => {
    state.cancelled = true;
    controller.abort();
    delete window[RUN_KEY];
    originalClose();
  };
  const stop = () => {
    state.cancelled = true;
    controller.abort();
  };
  window[RUN_KEY] = { focus: shell.focus, stop };

  const host = location.hostname.replace(/^www\./i, '').toLowerCase();
  const videoId = extractVideoId(location.href);
  if (!(host === 'youtube.com' || host.endsWith('.youtube.com')) || !videoId) {
    renderError(shell, 'Нужна страница видео', 'Откройте обычное видео, Shorts или live-запись на youtube.com и повторите запуск.');
    return;
  }

  let defaults = { wantTranscript: true, wantTracks: false, formats: ['txt-time'] };
  try { defaults = { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch (_) {}
  const selected = await renderSettings(shell, defaults, async status => {
    if (controller.signal.aborted) controller = new AbortController();
    return getTrackCatalog(videoId, controller.signal, progress => status(`Проверяю ${progress.label} (${progress.index + 1}/${progress.total})…`));
  });
  if (!selected) return;
  state.cancelled = false;
  if (controller.signal.aborted) controller = new AbortController();
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      wantTranscript: selected.settings.wantTranscript,
      wantTracks: selected.settings.wantTracks,
      formats: selected.settings.formats
    }));
  } catch (_) {}

  const progress = renderProgress(shell, stop);
  const downloads = [];
  const warnings = [];
  let catalog = selected.catalog;
  let playerResponse = catalog?.playerResponse || getWebPlayerResponse(videoId);
  let metadata = getMetadata(playerResponse, videoId);

  try {
    if (selected.settings.wantTranscript && !state.cancelled) {
      progress.update({ stage: 'Читаю открытую панель «Расшифровка»…', detail: 'Кнопки YouTube не нажимаются. Прокручивается только контейнер расшифровки.', percent: 12 });
      try {
        const transcript = await collectTranscriptPanel(state, data => progress.update({
          stage: 'Читаю открытую панель «Расшифровка»…',
          detail: `Собрано фрагментов: ${data.count}\nШаг безопасной прокрутки: ${data.step}`,
          percent: Math.min(58, 12 + data.step / 8)
        }));
        const language = detectTranscriptLanguage();
        downloads.push(...prepareDownloads({
          baseName: `${metadata.title} - YouTube Transcript - ${language}`,
          type: 'YOUTUBE TRANSCRIPT PANEL EXPORT',
          metadata,
          language,
          trackType: 'Текущая расшифровка из открытой панели YouTube',
          sourceMethod: `DOM панели YouTube; ограниченная прокрутка: ${transcript.scrollerFound ? 'использована' : 'не потребовалась'}`,
          rawCues: transcript.cues,
          videoDuration: metadata.duration,
          formats: selected.settings.formats,
          partial: transcript.partial,
          txtUsesRanges: false
        }));
        if (transcript.partial) warnings.push('Расшифровка из панели сохранена частично: выполнение остановлено пользователем.');
      } catch (error) {
        if (!selected.settings.wantTracks) throw error;
        warnings.push(`Расшифровка из панели не сохранена:\n${cleanText(error?.message || error)}`);
      }
    }

    if (selected.settings.wantTracks && !state.cancelled) {
      if (!catalog) {
        progress.update({ stage: 'Получаю список дорожек…', detail: '', percent: 20 });
        catalog = await getTrackCatalog(videoId, controller.signal, data => progress.update({ stage: `Проверяю ${data.label}…`, detail: `${data.index + 1} из ${data.total}`, percent: 20 + (data.index + 1) / Math.max(1, data.total) * 20 }));
      }
      playerResponse = catalog.playerResponse || playerResponse;
      metadata = getMetadata(playerResponse, videoId);
      const selectedTracks = selected.settings.selectedTrackIndexes.map(index => catalog.tracks[index]).filter(Boolean);
      for (const [position, track] of selectedTracks.entries()) {
        if (state.cancelled) break;
        progress.update({
          stage: `Загружаю дорожку ${position + 1} из ${selectedTracks.length}`,
          detail: `${track.name} [${track.languageCode}]\nКандидатов источника: ${track.sources.length}\nПодготовлено файлов: ${downloads.length}`,
          percent: 45 + position / Math.max(1, selectedTracks.length) * 48
        });
        try {
          const fetched = await fetchTrackCues(track, { signal: controller.signal });
          const label = `${track.name} [${track.languageCode}] - ${track.isGenerated ? 'авто' : 'ручные'}`;
          downloads.push(...prepareDownloads({
            baseName: `${metadata.title} - YouTube Subtitles - ${label}`,
            type: 'YOUTUBE SUBTITLE TRACK EXPORT',
            metadata,
            language: `${track.name} [${track.languageCode}]`,
            trackType: track.isGenerated ? 'Автоматически созданная YouTube' : 'Ручная или добавленная автором',
            sourceMethod: `Внутренний player API YouTube; рабочий источник ${fetched.sourceLabel}`,
            rawCues: fetched.cues,
            videoDuration: metadata.duration,
            formats: selected.settings.formats,
            partial: false,
            txtUsesRanges: true
          }));
        } catch (error) {
          if (error?.name === 'AbortError') break;
          const attempts = error?.attempts || [];
          const forbidden = attempts.filter(attempt => attempt.status === 403).length;
          const empty = attempts.filter(attempt => attempt.reason === 'empty').length;
          const unrecognized = attempts.filter(attempt => ['unrecognized', 'parse-error'].includes(attempt.reason)).length;
          const tokenText = forbidden ? ' YouTube отклонил часть URL (HTTP 403); возможна защита video-bound PO Token.' : '';
          warnings.push(`${track.name} [${track.languageCode}] не сохранена.${tokenText}\nПопыток: ${attempts.length}; пустых ответов: ${empty}; нераспознанных: ${unrecognized}.`);
        }
      }
      if (catalog.errors?.length) warnings.push(`Диагностика резервных профилей:\n${catalog.errors.join('\n')}`);
    }

    if (state.cancelled && downloads.length) warnings.push('Выполнение остановлено; доступны только уже подготовленные файлы.');
    if (!downloads.length) {
      const detail = warnings.length ? warnings.join('\n\n') : state.cancelled ? 'Экспорт остановлен до подготовки первого файла.' : 'Ни один источник не вернул текст.';
      renderError(shell, 'Файлы не подготовлены', detail);
      return;
    }
    progress.update({ stage: 'Файлы подготовлены', detail: `Всего: ${downloads.length}`, percent: 100 });
    renderResult(shell, downloads, warnings, state.cancelled);
  } catch (error) {
    if (error?.name === 'AbortError') {
      if (downloads.length) renderResult(shell, downloads, [...warnings, 'Операция остановлена пользователем.'], true);
      else renderError(shell, 'Экспорт остановлен', 'Файлы не успели подготовиться.');
    } else renderError(shell, 'Экспорт не выполнен', cleanText(error?.message || error));
  }
})();
