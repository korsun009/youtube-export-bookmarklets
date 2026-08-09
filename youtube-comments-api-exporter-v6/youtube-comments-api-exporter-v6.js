(async () => {
  'use strict';

  const VERSION = '6.0';
  const STORAGE_KEY = 'yt-comments-exporter-api-key-v6';
  const SETTINGS_KEY = 'yt-comments-exporter-settings-v6';
  const RUN_KEY = '__YT_COMMENTS_EXPORTER_API_V6__';
  const DAILY_QUOTA_BASELINE = 10000;

  const clean = value => String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const safeFileName = value => clean(value)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .slice(0, 140) || 'YouTube';

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

  const parseLimit = value => {
    const text = String(value ?? '').trim();
    if (!/^\d+$/.test(text)) throw new Error('Введите целое число 0 или больше.');
    const parsed = Number(text);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Введите целое число 0 или больше.');
    return parsed;
  };

  const formatPercent = value => {
    if (!Number.isFinite(value)) return '—';
    if (value > 0 && value < 0.01) return '<0,01%';
    return `${value.toFixed(value < 1 ? 2 : 1).replace('.', ',')}%`;
  };

  const normalizeComment = comment => {
    const snippet = comment?.snippet || {};
    return {
      id: clean(comment?.id),
      parentId: clean(snippet.parentId),
      author: clean(snippet.authorDisplayName) || '—',
      authorUrl: clean(snippet.authorChannelUrl),
      authorChannelId: clean(snippet.authorChannelId?.value),
      text: clean(snippet.textOriginal || snippet.textDisplay),
      likes: Number.isFinite(Number(snippet.likeCount)) ? Number(snippet.likeCount) : 0,
      publishedAt: clean(snippet.publishedAt),
      updatedAt: clean(snippet.updatedAt),
      replies: []
    };
  };

  const requestWithRetry = async (operation, options = {}) => {
    const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const isStopped = options.isStopped || (() => false);
    const maxAttempts = Math.max(1, Number(options.maxAttempts) || 3);
    const retryable = new Set([429, 500, 502, 503, 504]);
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (isStopped()) throw new DOMException('Остановлено пользователем', 'AbortError');
      try {
        return await operation(attempt);
      } catch (error) {
        lastError = error;
        if (!retryable.has(Number(error?.status)) || attempt >= maxAttempts) throw error;
        const retryAfterMs = Number(error?.retryAfter) > 0
          ? Number(error.retryAfter) * 1000
          : Math.min(8000, 700 * (2 ** (attempt - 1)));
        await sleep(retryAfterMs);
      }
    }
    throw lastError || new Error('Запрос не выполнен.');
  };

  const collectComments = async (options, transport, hooks = {}) => {
    const includeReplies = Boolean(options.includeReplies);
    const limit = Number(options.limit) || 0;
    const limitMode = options.limitMode === 'total' ? 'total' : 'top';
    const isStopped = hooks.isStopped || (() => false);
    const onProgress = hooks.onProgress || (() => {});
    const records = [];
    const seenTop = new Set();
    const seenReplies = new Set();
    const seenThreadTokens = new Set();
    const diagnostics = {
      threadPages: 0,
      replyPages: 0,
      threadItemsSeen: 0,
      duplicateTop: 0,
      duplicateReplies: 0,
      expectedRepliesInLoadedThreads: 0,
      embeddedRepliesSeen: 0,
      embeddedRepliesAccepted: 0,
      threadsSatisfiedByEmbeddedReplies: 0,
      threadsFetchedViaCommentsList: 0,
      threadsWithReplyCountMismatch: 0,
      repeatedThreadPageToken: false,
      repeatedReplyPageTokens: 0
    };

    const counts = () => {
      const top = records.length;
      const replies = records.reduce((sum, record) => sum + record.replies.length, 0);
      return { top, replies, total: top + replies };
    };
    const limitReached = () => {
      if (limit === 0) return false;
      const current = counts();
      return limitMode === 'total' ? current.total >= limit : current.top >= limit;
    };
    const appendReply = (record, rawReply, source) => {
      const reply = normalizeComment(rawReply);
      if (!reply.id) return false;
      if (seenReplies.has(reply.id)) {
        diagnostics.duplicateReplies += 1;
        return false;
      }
      if (limit > 0 && limitMode === 'total' && counts().total >= limit) return false;
      seenReplies.add(reply.id);
      record.replies.push(reply);
      if (source === 'embedded') diagnostics.embeddedRepliesAccepted += 1;
      return true;
    };

    const loadReplies = async (record, expected) => {
      let pageToken = '';
      const seenReplyTokens = new Set();
      while (!isStopped() && !(limit > 0 && limitMode === 'total' && counts().total >= limit)) {
        const tokenKey = pageToken || '__FIRST__';
        if (seenReplyTokens.has(tokenKey)) {
          diagnostics.repeatedReplyPageTokens += 1;
          break;
        }
        seenReplyTokens.add(tokenKey);
        const page = await transport('comments', {
          part: 'snippet',
          parentId: record.id,
          maxResults: 100,
          pageToken,
          textFormat: 'plainText'
        });
        diagnostics.replyPages += 1;
        for (const item of page.items || []) {
          appendReply(record, item, 'api');
          if (limit > 0 && limitMode === 'total' && counts().total >= limit) break;
        }
        pageToken = clean(page.nextPageToken);
        onProgress({ stage: 'replies', counts: counts(), diagnostics, expected });
        if (!pageToken) break;
      }
    };

    const processReplies = async (record, thread) => {
      if (!includeReplies) return;
      const expected = Number(thread?.snippet?.totalReplyCount || 0);
      if (!Number.isFinite(expected) || expected <= 0) return;
      diagnostics.expectedRepliesInLoadedThreads += expected;
      const embedded = Array.isArray(thread?.replies?.comments) ? thread.replies.comments : [];
      diagnostics.embeddedRepliesSeen += embedded.length;
      for (const reply of embedded) {
        appendReply(record, reply, 'embedded');
        if (limit > 0 && limitMode === 'total' && counts().total >= limit) break;
      }
      if (limit > 0 && limitMode === 'total' && counts().total >= limit) return;
      if (record.replies.length >= expected) {
        diagnostics.threadsSatisfiedByEmbeddedReplies += 1;
        return;
      }
      diagnostics.threadsFetchedViaCommentsList += 1;
      await loadReplies(record, expected);
      if (!isStopped() && !(limit > 0 && limitMode === 'total' && counts().total >= limit) && record.replies.length !== expected) {
        diagnostics.threadsWithReplyCountMismatch += 1;
      }
    };

    let pageToken = '';
    let error = '';
    try {
      outer:
      while (!isStopped() && !limitReached()) {
        const tokenKey = pageToken || '__FIRST__';
        if (seenThreadTokens.has(tokenKey)) {
          diagnostics.repeatedThreadPageToken = true;
          break;
        }
        seenThreadTokens.add(tokenKey);
        const page = await transport('commentThreads', {
          part: 'snippet,replies',
          videoId: options.videoId,
          maxResults: 100,
          order: options.order === 'relevance' ? 'relevance' : 'time',
          pageToken,
          textFormat: 'plainText'
        });
        diagnostics.threadPages += 1;
        diagnostics.threadItemsSeen += (page.items || []).length;
        for (const thread of page.items || []) {
          if (limitReached()) break outer;
          const record = normalizeComment(thread?.snippet?.topLevelComment);
          if (!record.id) continue;
          if (seenTop.has(record.id)) {
            diagnostics.duplicateTop += 1;
            continue;
          }
          seenTop.add(record.id);
          records.push(record);
          await processReplies(record, thread);
          onProgress({ stage: 'threads', counts: counts(), diagnostics });
          if (limitReached()) break outer;
        }
        pageToken = clean(page.nextPageToken);
        if (!pageToken) break;
      }
    } catch (caught) {
      if (caught?.name !== 'AbortError') error = clean(caught?.message || caught);
    }

    return { records, diagnostics, counts: counts(), stopped: Boolean(isStopped()), error };
  };

  const getModelCounts = model => {
    const top = model.records?.length || 0;
    const replies = (model.records || []).reduce((sum, record) => sum + (record.replies?.length || 0), 0);
    return { top, replies, total: top + replies };
  };

  const publicSettings = settings => ({
    includeReplies: Boolean(settings?.includeReplies),
    order: settings?.order === 'relevance' ? 'relevance' : 'time',
    limit: Number(settings?.limit) || 0,
    limitMode: settings?.limitMode === 'total' ? 'total' : 'top',
    formats: Array.isArray(settings?.formats) ? settings.formats.filter(value => ['txt', 'md', 'json', 'csv'].includes(value)) : undefined
  });

  const formatDate = value => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? clean(value) : date.toLocaleString('ru-RU');
  };

  const buildTextExport = model => {
    const counts = getModelCounts(model);
    const settings = publicSettings(model.settings);
    const reported = Number(model.meta?.reportedCommentCount);
    const coverage = Number.isFinite(reported) && reported > 0 ? counts.total / reported * 100 : null;
    const lines = [
      'YOUTUBE COMMENTS EXPORT',
      '=======================',
      `Версия экспортёра: ${VERSION}`,
      'Источник: официальный YouTube Data API v3',
      `Видео: ${clean(model.meta?.title) || 'YouTube video'}`,
      ...(clean(model.meta?.channel) ? [`Канал: ${clean(model.meta.channel)}`] : []),
      `Video ID: ${clean(model.meta?.videoId)}`,
      `URL: ${clean(model.meta?.canonicalUrl)}`,
      `Дата экспорта: ${formatDate(model.meta?.exportedAt || new Date().toISOString())}`,
      ...(Number.isFinite(reported) ? [`Счётчик комментариев у видео через API: ${reported}`] : []),
      `Раскрывать ответы: ${settings.includeReplies ? 'Да' : 'Нет'}`,
      `Лимит: ${settings.limit === 0 ? 'без лимита' : settings.limit}`,
      ...(settings.includeReplies ? [`Тип лимита: ${settings.limitMode === 'total' ? 'основные комментарии + ответы' : 'только основные комментарии'}`] : []),
      `Сортировка: ${settings.order === 'time' ? 'по времени — максимально полный обход' : 'по релевантности — выборка лучших веток'}`,
      '',
      '--- ИТОГ ---',
      `Основных веток выгружено: ${counts.top}`,
      `Ответов фактически получено: ${counts.replies}`,
      `Всего сообщений: ${counts.total}`,
      ...(coverage !== null ? [`Доля от счётчика видео: ${formatPercent(coverage)} (${counts.total} из ${reported})`] : []),
      `Страниц основных комментариев: ${Number(model.diagnostics?.threadPages) || 0}`,
      `Страниц ответов: ${Number(model.diagnostics?.replyPages) || 0}`,
      `API-запросов: ${Number(model.diagnostics?.requestCount) || 0}`,
      `Остановлено пользователем: ${model.stopped ? 'Да' : 'Нет'}`,
      ...(clean(model.error) ? [`Ошибка при завершении: ${clean(model.error)}`] : []),
      '',
      '--- ТЕХНИЧЕСКАЯ ДИАГНОСТИКА ---',
      `Дубликатов основных: ${Number(model.diagnostics?.duplicateTop) || 0}`,
      `Дубликатов ответов: ${Number(model.diagnostics?.duplicateReplies) || 0}`,
      `Повтор токена страниц веток: ${model.diagnostics?.repeatedThreadPageToken ? 'Да' : 'Нет'}`,
      `Повторов токена страниц ответов: ${Number(model.diagnostics?.repeatedReplyPageTokens) || 0}`,
      ''
    ];
    for (const [index, record] of (model.records || []).entries()) {
      const commentUrl = `${model.meta?.canonicalUrl || ''}&lc=${encodeURIComponent(record.id)}`;
      lines.push(`========== ${index + 1}. COMMENT ==========`, `Автор: ${record.author}`, `Лайки: ${record.likes}`, `Ссылка: ${commentUrl}`);
      if (record.authorUrl) lines.push(`Канал автора: ${record.authorUrl}`);
      if (record.publishedAt) lines.push(`Опубликован: ${formatDate(record.publishedAt)}`);
      if (record.updatedAt && record.updatedAt !== record.publishedAt) lines.push(`Изменён: ${formatDate(record.updatedAt)}`);
      lines.push('', record.text || '');
      for (const [replyIndex, reply] of (record.replies || []).entries()) {
        const replyUrl = `${model.meta?.canonicalUrl || ''}&lc=${encodeURIComponent(reply.id)}`;
        lines.push('', `----- ${index + 1}.${replyIndex + 1}. REPLY -----`, `Автор: ${reply.author}`, `Лайки: ${reply.likes}`, `Ссылка: ${replyUrl}`);
        if (reply.authorUrl) lines.push(`Канал автора: ${reply.authorUrl}`);
        if (reply.publishedAt) lines.push(`Опубликован: ${formatDate(reply.publishedAt)}`);
        if (reply.updatedAt && reply.updatedAt !== reply.publishedAt) lines.push(`Изменён: ${formatDate(reply.updatedAt)}`);
        lines.push('', reply.text || '');
      }
      lines.push('');
    }
    return lines.join('\n');
  };

  const buildJsonExport = model => JSON.stringify({
    exporter: { name: 'YouTube Comments Exporter', version: VERSION, source: 'YouTube Data API v3' },
    meta: { ...(model.meta || {}) },
    settings: publicSettings(model.settings),
    counts: getModelCounts(model),
    diagnostics: { ...(model.diagnostics || {}) },
    stopped: Boolean(model.stopped),
    error: clean(model.error),
    comments: model.records || []
  }, null, 2);

  const escapeMarkdownInline = value => clean(value).replace(/([\\`*_[\]{}()#+\-.!|>])/g, '\\$1');
  const quoteMarkdown = value => (clean(value) || '—').split('\n').map(line => `> ${line}`).join('\n');

  const buildMarkdownExport = model => {
    const counts = getModelCounts(model);
    const settings = publicSettings(model.settings);
    const reported = Number(model.meta?.reportedCommentCount);
    const coverage = Number.isFinite(reported) && reported > 0 ? counts.total / reported * 100 : null;
    const lines = [
      `# Комментарии YouTube: ${escapeMarkdownInline(model.meta?.title || 'YouTube video')}`,
      '',
      `- **Канал:** ${escapeMarkdownInline(model.meta?.channel || '—')}`,
      `- **Видео:** [открыть на YouTube](${clean(model.meta?.canonicalUrl)})`,
      `- **Video ID:** \`${clean(model.meta?.videoId)}\``,
      `- **Дата экспорта:** ${escapeMarkdownInline(formatDate(model.meta?.exportedAt || new Date().toISOString()))}`,
      `- **Основных веток:** ${counts.top}`,
      `- **Ответов:** ${counts.replies}`,
      `- **Всего сообщений:** ${counts.total}`,
      ...(Number.isFinite(reported) ? [`- **Счётчик комментариев у видео через API:** ${reported}`] : []),
      ...(coverage !== null ? [`- **Доля от счётчика видео:** ${formatPercent(coverage)} (${counts.total} из ${reported})`] : []),
      `- **Сортировка:** ${settings.order === 'time' ? 'по времени' : 'по релевантности'}`,
      `- **Остановлено пользователем:** ${model.stopped ? 'да' : 'нет'}`,
      ...(clean(model.error) ? [`- **Предупреждение:** ${escapeMarkdownInline(model.error)}`] : []),
      '',
      '---',
      ''
    ];
    for (const [index, record] of (model.records || []).entries()) {
      const commentUrl = `${model.meta?.canonicalUrl || ''}&lc=${encodeURIComponent(record.id)}`;
      lines.push(
        `## ${index + 1}. ${escapeMarkdownInline(record.author || '—')}`,
        '',
        `- [Открыть комментарий](${commentUrl})`,
        `- Лайки: ${Number(record.likes) || 0}`,
        ...(record.authorUrl ? [`- [Канал автора](${record.authorUrl})`] : []),
        ...(record.publishedAt ? [`- Опубликован: ${escapeMarkdownInline(formatDate(record.publishedAt))}`] : []),
        ...(record.updatedAt && record.updatedAt !== record.publishedAt ? [`- Изменён: ${escapeMarkdownInline(formatDate(record.updatedAt))}`] : []),
        '',
        quoteMarkdown(record.text),
        ''
      );
      for (const [replyIndex, reply] of (record.replies || []).entries()) {
        const replyUrl = `${model.meta?.canonicalUrl || ''}&lc=${encodeURIComponent(reply.id)}`;
        lines.push(
          `### Ответ ${index + 1}.${replyIndex + 1}: ${escapeMarkdownInline(reply.author || '—')}`,
          '',
          `- [Открыть ответ](${replyUrl})`,
          `- Лайки: ${Number(reply.likes) || 0}`,
          ...(reply.authorUrl ? [`- [Канал автора](${reply.authorUrl})`] : []),
          ...(reply.publishedAt ? [`- Опубликован: ${escapeMarkdownInline(formatDate(reply.publishedAt))}`] : []),
          '',
          quoteMarkdown(reply.text),
          ''
        );
      }
      lines.push('---', '');
    }
    return lines.join('\n');
  };

  const csvCell = value => {
    let text = String(value ?? '');
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };

  const buildCsvExport = model => {
    const headers = ['type', 'id', 'parent_id', 'author', 'author_channel_id', 'author_url', 'published_at', 'updated_at', 'likes', 'url', 'text'];
    const rows = [headers];
    const baseUrl = model.meta?.canonicalUrl || '';
    for (const record of model.records || []) {
      rows.push(['comment', record.id, '', record.author, record.authorChannelId, record.authorUrl, record.publishedAt, record.updatedAt, record.likes, `${baseUrl}&lc=${encodeURIComponent(record.id)}`, record.text]);
      for (const reply of record.replies || []) {
        rows.push(['reply', reply.id, reply.parentId || record.id, reply.author, reply.authorChannelId, reply.authorUrl, reply.publishedAt, reply.updatedAt, reply.likes, `${baseUrl}&lc=${encodeURIComponent(reply.id)}`, reply.text]);
      }
    }
    return `\uFEFF${rows.map(row => row.map(csvCell).join(';')).join('\n')}\n`;
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

  const validateSettings = input => {
    const apiKey = clean(input?.apiKey);
    if (!apiKey) throw new Error('Введите API key YouTube Data API v3.');
    const formats = [...new Set((input?.formats || []).filter(value => ['txt', 'md', 'json', 'csv'].includes(value)))];
    if (!formats.length) throw new Error('Выберите хотя бы один формат файла.');
    return {
      apiKey,
      saveKey: Boolean(input?.saveKey),
      includeReplies: Boolean(input?.includeReplies),
      order: input?.order === 'relevance' ? 'relevance' : 'time',
      limit: parseLimit(input?.limit),
      limitMode: input?.limitMode === 'total' ? 'total' : 'top',
      formats
    };
  };

  const el = (tag, options = {}, children = []) => {
    const node = document.createElement(tag);
    if (options.text !== undefined) node.textContent = String(options.text);
    if (options.className) node.className = options.className;
    for (const [name, value] of Object.entries(options.attrs || {})) {
      if (value !== undefined && value !== null) node.setAttribute(name, String(value));
    }
    Object.assign(node.style, options.style || {});
    for (const [eventName, handler] of Object.entries(options.on || {})) node.addEventListener(eventName, handler);
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) if (child) node.append(child);
    return node;
  };

  const createShell = (title = 'Экспорт комментариев YouTube') => {
    const previousFocus = document.activeElement;
    const style = el('style', { text: `
#ytce-v6-backdrop{position:fixed;inset:0;z-index:2147483646;display:grid;place-items:center;padding:18px;background:radial-gradient(circle at 18% 8%,rgba(51,199,210,.19),transparent 36%),rgba(3,7,10,.86);backdrop-filter:blur(8px);font-family:"Segoe UI Variable Text","Trebuchet MS",sans-serif;color:#edf8f8}
#ytce-v6-panel{width:min(680px,96vw);max-height:92vh;overflow:auto;box-sizing:border-box;padding:24px;background:linear-gradient(155deg,#111c21 0%,#081015 65%,#10191b 100%);border:1px solid rgba(111,224,229,.36);border-radius:20px;box-shadow:0 30px 100px rgba(0,0,0,.72),inset 0 1px rgba(255,255,255,.06)}
#ytce-v6-panel *{box-sizing:border-box}#ytce-v6-panel h2{margin:0;font:650 29px/1.08 Georgia,"Times New Roman",serif;letter-spacing:-.025em}#ytce-v6-panel p{margin:7px 0 0;color:#a9bcc0;line-height:1.5}
.ytce-kicker{color:#78dce2;font:750 11px/1.2 ui-monospace,Consolas,monospace;letter-spacing:.18em;text-transform:uppercase}.ytce-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:18px}.ytce-card{padding:14px;border:1px solid #2d444a;border-radius:13px;background:rgba(255,255,255,.025)}.ytce-wide{grid-column:1/-1}.ytce-label{display:block;margin-bottom:7px;color:#dcebed;font-size:13px;font-weight:700}.ytce-hint{margin-top:7px;color:#8fa5aa;font-size:12px;line-height:1.4}
.ytce-input,.ytce-select{width:100%;padding:10px 11px;border:1px solid #3b555b;border-radius:9px;background:#081014;color:#f2fbfb;outline:none}.ytce-input:focus,.ytce-select:focus{border-color:#78dce2;box-shadow:0 0 0 3px rgba(120,220,226,.12)}.ytce-checks{display:flex;flex-wrap:wrap;gap:9px 15px}.ytce-check{display:flex;align-items:center;gap:7px;color:#d5e4e6}.ytce-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:9px;margin-top:18px}.ytce-btn{border:0;border-radius:10px;padding:10px 15px;cursor:pointer;font-weight:780;background:#26383d;color:#eef8f9}.ytce-btn:hover{filter:brightness(1.12)}.ytce-btn:disabled{cursor:default;opacity:.55}.ytce-primary{background:#78dce2;color:#061014;box-shadow:0 9px 28px rgba(42,180,194,.23)}.ytce-danger{background:#7b292b;color:#fff}.ytce-error{margin-top:12px;padding:10px 12px;border:1px solid #8e4243;border-radius:10px;background:rgba(139,43,45,.18);color:#ffc5c5;white-space:pre-line}.ytce-warning{margin-top:12px;padding:10px 12px;border:1px solid #85691d;border-radius:10px;background:rgba(134,99,19,.15);color:#ffe19a;white-space:pre-line}
.ytce-statgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin:18px 0}.ytce-stat{padding:12px;border:1px solid #294148;border-radius:11px;background:#0b1519}.ytce-stat b{display:block;color:#7ce2e7;font-size:21px}.ytce-progress{height:7px;overflow:hidden;border-radius:99px;background:#1e3035}.ytce-progress span{display:block;height:100%;width:8%;border-radius:inherit;background:linear-gradient(90deg,#55c9d2,#b4f2e1);transition:width .25s ease}.ytce-files{display:grid;gap:8px;margin-top:14px}.ytce-file{width:100%;text-align:left;word-break:break-word}.ytce-muted{color:#93a8ad;white-space:pre-line;line-height:1.55}@media(max-width:620px){#ytce-v6-panel{padding:18px}.ytce-grid,.ytce-statgrid{grid-template-columns:1fr}.ytce-wide{grid-column:auto}}
` });
    const backdrop = el('div', { attrs: { id: 'ytce-v6-backdrop' } });
    const panel = el('section', { attrs: { id: 'ytce-v6-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: '-1' } });
    const content = el('div');
    panel.append(content);
    backdrop.append(panel);
    document.documentElement.append(style, backdrop);
    const close = () => {
      backdrop.remove();
      style.remove();
      if (previousFocus?.focus) previousFocus.focus();
    };
    const keyHandler = event => {
      if (event.key === 'Escape' && backdrop.dataset.locked !== 'true') close();
    };
    backdrop.addEventListener('keydown', keyHandler);
    queueMicrotask(() => panel.focus());
    return { backdrop, panel, content, close, focus: () => panel.focus() };
  };

  const heading = (title, subtitle) => el('div', {}, [
    el('div', { className: 'ytce-kicker', text: `YouTube local archive · v${VERSION}` }),
    el('h2', { text: title }),
    el('p', { text: subtitle })
  ]);

  const button = (text, kind = '', handler = null) => el('button', {
    className: `ytce-btn ${kind}`.trim(), attrs: { type: 'button' }, text,
    on: handler ? { click: handler } : {}
  });

  const labeledCheck = (name, text, checked = false) => {
    const input = el('input', { attrs: { type: 'checkbox', name } });
    input.checked = checked;
    return { input, label: el('label', { className: 'ytce-check' }, [input, el('span', { text })]) };
  };

  const renderSettings = (shell, defaults, actions = {}) => new Promise(resolve => {
    shell.backdrop.dataset.locked = 'false';
    const apiKey = el('input', { className: 'ytce-input', attrs: { type: 'password', autocomplete: 'off', spellcheck: 'false', value: defaults.apiKey || '', placeholder: 'AIza…', 'aria-label': 'YouTube Data API key' } });
    const saveKey = labeledCheck('saveKey', 'Сохранить ключ только в этом браузере', defaults.saveKey !== false);
    const includeReplies = labeledCheck('includeReplies', 'Выгружать ответы', defaults.includeReplies !== false);
    const order = el('select', { className: 'ytce-select', attrs: { 'aria-label': 'Порядок комментариев' } }, [
      el('option', { attrs: { value: 'time' }, text: 'Максимально полный обход (time)' }),
      el('option', { attrs: { value: 'relevance' }, text: 'Лучшие / релевантные' })
    ]);
    order.value = defaults.order || 'time';
    const limit = el('input', { className: 'ytce-input', attrs: { type: 'number', min: '0', step: '1', inputmode: 'numeric', value: String(defaults.limit ?? 500), 'aria-label': 'Лимит сообщений' } });
    const limitMode = el('select', { className: 'ytce-select', attrs: { 'aria-label': 'Тип лимита' } }, [
      el('option', { attrs: { value: 'total' }, text: 'Основные + ответы вместе' }),
      el('option', { attrs: { value: 'top' }, text: 'Только основные; ответы сверх лимита' })
    ]);
    limitMode.value = defaults.limitMode || 'total';
    const formatChecks = ['txt', 'md', 'json', 'csv'].map(id => labeledCheck(`format-${id}`, id.toUpperCase(), (defaults.formats || ['txt']).includes(id)));
    const errorBox = el('div', { className: 'ytce-error', attrs: { hidden: 'hidden', role: 'alert' } });
    const clearButton = button('Удалить сохранённый ключ', '', () => {
      actions.clearKey?.();
      apiKey.value = '';
      saveKey.input.checked = false;
      clearButton.textContent = 'Сохранённый ключ удалён';
      clearButton.disabled = true;
    });
    const repliesToggle = () => {
      limitMode.disabled = !includeReplies.input.checked;
      limitMode.closest?.('.ytce-card')?.toggleAttribute('data-disabled', !includeReplies.input.checked);
    };
    includeReplies.input.addEventListener('change', repliesToggle);
    const grid = el('div', { className: 'ytce-grid' }, [
      el('div', { className: 'ytce-card ytce-wide' }, [el('label', { className: 'ytce-label', text: 'YouTube Data API key' }), apiKey, el('div', { className: 'ytce-checks', style: { marginTop: '9px' } }, [saveKey.label, clearButton]), el('div', { className: 'ytce-hint', text: 'Ключ используется только для публичного чтения через официальный API и не попадает в файлы.' })]),
      el('div', { className: 'ytce-card' }, [el('label', { className: 'ytce-label', text: 'Состав выгрузки' }), includeReplies.label]),
      el('div', { className: 'ytce-card' }, [el('label', { className: 'ytce-label', text: 'Порядок' }), order]),
      el('div', { className: 'ytce-card' }, [el('label', { className: 'ytce-label', text: 'Максимум сообщений' }), limit, el('div', { className: 'ytce-hint', text: '0 — без лимита.' })]),
      el('div', { className: 'ytce-card' }, [el('label', { className: 'ytce-label', text: 'Что ограничивает число' }), limitMode]),
      el('div', { className: 'ytce-card ytce-wide' }, [el('label', { className: 'ytce-label', text: 'Форматы' }), el('div', { className: 'ytce-checks' }, formatChecks.map(item => item.label)), el('div', { className: 'ytce-hint', text: 'TXT — чтение, MD — заметки и базы знаний, JSON — обработка, CSV — таблица.' })])
    ]);
    const cancel = button('Отмена', '', () => { shell.close(); resolve(null); });
    const start = button('Начать экспорт', 'ytce-primary', () => {
      try {
        const settings = validateSettings({
          apiKey: apiKey.value,
          saveKey: saveKey.input.checked,
          includeReplies: includeReplies.input.checked,
          order: order.value,
          limit: limit.value,
          limitMode: limitMode.value,
          formats: formatChecks.filter(item => item.input.checked).map(item => item.input.name.replace('format-', ''))
        });
        errorBox.hidden = true;
        resolve(settings);
      } catch (error) {
        errorBox.textContent = error.message || String(error);
        errorBox.hidden = false;
      }
    });
    shell.content.replaceChildren(
      heading('Экспорт комментариев YouTube', 'Официальный API, управляемый лимит и локальное сохранение. Все параметры видны до запуска.'),
      grid,
      errorBox,
      el('div', { className: 'ytce-actions' }, [cancel, start])
    );
    repliesToggle();
    queueMicrotask(() => apiKey.focus());
  });

  const renderProgress = (shell, onStop) => {
    shell.backdrop.dataset.locked = 'true';
    const stage = el('p', { className: 'ytce-muted', text: 'Подготовка…' });
    const top = el('b', { text: '0' });
    const replies = el('b', { text: '0' });
    const requests = el('b', { text: '0' });
    const bar = el('span');
    const detail = el('div', { className: 'ytce-muted' });
    const stop = button('Остановить и сохранить найденное', 'ytce-danger', () => {
      stop.disabled = true;
      stop.textContent = 'Остановка запрошена…';
      onStop();
    });
    shell.content.replaceChildren(
      heading('Идёт экспорт', 'Можно остановить процесс: уже найденные сообщения будут подготовлены к скачиванию.'),
      stage,
      el('div', { className: 'ytce-statgrid' }, [
        el('div', { className: 'ytce-stat' }, [top, el('span', { text: 'Основных' })]),
        el('div', { className: 'ytce-stat' }, [replies, el('span', { text: 'Ответов' })]),
        el('div', { className: 'ytce-stat' }, [requests, el('span', { text: 'API-запросов' })])
      ]),
      el('div', { className: 'ytce-progress' }, bar),
      detail,
      el('div', { className: 'ytce-actions' }, stop)
    );
    return {
      update(data = {}) {
        stage.textContent = data.stage || stage.textContent;
        top.textContent = String(data.top ?? 0);
        replies.textContent = String(data.replies ?? 0);
        requests.textContent = String(data.requests ?? 0);
        const coverage = Number(data.coverage);
        bar.style.width = Number.isFinite(coverage) ? `${Math.max(2, Math.min(100, coverage))}%` : `${8 + ((Number(data.requests) || 0) % 10) * 7}%`;
        detail.textContent = data.detail || '';
      }
    };
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

  const triggerZipDownload = (files, filename) => {
    const url = URL.createObjectURL(new Blob([buildZipBytes(files)], { type: 'application/zip' }));
    const anchor = el('a', { attrs: { href: url, download: filename } });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const renderResult = (shell, result) => {
    shell.backdrop.dataset.locked = 'false';
    const status = result.stopped ? 'Частичный экспорт подготовлен' : result.error ? 'Экспорт завершён с предупреждением' : 'Экспорт подготовлен';
    const note = el('div', { className: result.error ? 'ytce-warning' : 'ytce-muted', text: result.error || `${result.counts.total} сообщений готовы к сохранению.` });
    const files = el('div', { className: 'ytce-files' });
    for (const item of result.files) files.append(button(item.filename, 'ytce-file', () => triggerDownload(item)));
    const all = button(`Скачать всё ZIP (${result.files.length})`, 'ytce-primary', () => {
      triggerZipDownload(result.files, `${result.archiveName || 'YouTube Comments Export'}.zip`);
    });
    const close = button('Закрыть', '', () => shell.close());
    shell.content.replaceChildren(
      heading(status, `Основных: ${result.counts.top} · ответов: ${result.counts.replies} · API-запросов: ${result.requestCount}`),
      note,
      files,
      el('div', { className: 'ytce-actions' }, [close, all])
    );
  };

  const renderError = (shell, title, message) => {
    shell.backdrop.dataset.locked = 'false';
    shell.content.replaceChildren(
      heading(title, 'Экспорт не изменил страницу YouTube и не отправил данные на сторонние серверы.'),
      el('div', { className: 'ytce-error', text: message, attrs: { role: 'alert' } }),
      el('div', { className: 'ytce-actions' }, button('Закрыть', 'ytce-primary', () => shell.close()))
    );
  };

  const testedCore = {
    VERSION,
    clean,
    safeFileName,
    extractVideoId,
    parseLimit,
    formatPercent,
    normalizeComment,
    requestWithRetry,
    collectComments,
    getModelCounts,
    buildTextExport,
    buildMarkdownExport,
    buildJsonExport,
    buildCsvExport,
    buildZipBytes,
    validateSettings,
    createShell
  };

  if (globalThis.__YT_EXPORTER_TEST__) {
    globalThis.__YT_EXPORTER_TEST__.comments = testedCore;
    return;
  }

  if (window[RUN_KEY]?.focus) {
    window[RUN_KEY].focus();
    return;
  }

  const shell = createShell();
  let stopped = false;
  let activeController = null;
  let requestCount = 0;
  const originalClose = shell.close;
  shell.close = () => {
    stopped = true;
    activeController?.abort();
    delete window[RUN_KEY];
    originalClose();
  };
  const stop = () => {
    stopped = true;
    activeController?.abort();
  };
  window[RUN_KEY] = { focus: shell.focus, stop };

  const host = location.hostname.replace(/^www\./i, '').toLowerCase();
  const videoId = extractVideoId(location.href);
  if (!(host === 'youtube.com' || host.endsWith('.youtube.com')) || !videoId) {
    renderError(shell, 'Нужна страница видео', 'Откройте обычное видео, Shorts или live-запись на youtube.com и запустите закладку ещё раз.');
    return;
  }

  const readJson = (key, fallback) => {
    try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) || '{}') }; }
    catch (_) { return { ...fallback }; }
  };
  const defaults = readJson(SETTINGS_KEY, {
    includeReplies: true,
    order: 'time',
    limit: 500,
    limitMode: 'total',
    formats: ['txt'],
    saveKey: true
  });
  defaults.apiKey = localStorage.getItem(STORAGE_KEY) || localStorage.getItem('yt-comments-exporter-api-key-v5') || localStorage.getItem('yt-comments-exporter-api-key-v4') || '';

  const settings = await renderSettings(shell, defaults, {
    clearKey: () => {
      for (const key of [STORAGE_KEY, 'yt-comments-exporter-api-key-v5', 'yt-comments-exporter-api-key-v4']) localStorage.removeItem(key);
    }
  });
  if (!settings) return;
  stopped = false;
  shell.backdrop.dataset.locked = 'true';

  const storedSettings = publicSettings(settings);
  storedSettings.saveKey = settings.saveKey;
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(storedSettings)); } catch (_) {}

  const abortableSleep = ms => new Promise((resolve, reject) => {
    if (stopped) {
      reject(new DOMException('Остановлено пользователем', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Остановлено пользователем', 'AbortError'));
    };
    activeController?.signal.addEventListener('abort', onAbort, { once: true });
  });

  const apiMessage = error => {
    const known = {
      commentsDisabled: 'Комментарии у этого видео отключены.',
      quotaExceeded: 'Дневная квота YouTube Data API исчерпана.',
      dailyLimitExceeded: 'Дневной лимит API исчерпан.',
      dailyLimitExceededUnreg: 'API key не распознан или YouTube Data API v3 не включён.',
      accessNotConfigured: 'В проекте Google Cloud не включён YouTube Data API v3.',
      keyInvalid: 'API key недействителен.',
      ipRefererBlocked: 'Запрос отклонён ограничениями API key. Проверьте разрешённый HTTP referrer.',
      forbidden: 'Доступ отклонён. Проверьте ограничения API key.',
      videoNotFound: 'Видео не найдено или недоступно через API.',
      invalidPageToken: 'YouTube отклонил токен следующей страницы.'
    };
    return known[error?.reason] || clean(error?.apiMessage || error?.message || 'Неизвестная ошибка API.');
  };

  const apiGet = async (resource, params) => requestWithRetry(async () => {
    if (stopped) throw new DOMException('Остановлено пользователем', 'AbortError');
    activeController = new AbortController();
    requestCount += 1;
    const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
    for (const [key, value] of Object.entries({ ...params, key: settings.apiKey })) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    let response;
    try {
      response = await fetch(url.toString(), { signal: activeController.signal, credentials: 'omit', cache: 'no-store' });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      const wrapped = new Error('Браузер не смог обратиться к YouTube Data API. Проверьте интернет и блокировщики.');
      wrapped.status = 503;
      throw wrapped;
    }
    let payload = null;
    try { payload = await response.json(); } catch (_) {}
    if (response.ok && !payload?.error) return payload || {};
    const apiError = payload?.error || {};
    const first = apiError.errors?.[0] || {};
    const error = new Error(apiError.message || `HTTP ${response.status}`);
    error.status = response.status;
    error.reason = first.reason || apiError.status || '';
    error.apiMessage = apiError.message || '';
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      error.retryAfter = Number.isFinite(seconds) ? seconds : Math.max(0, (Date.parse(retryAfter) - Date.now()) / 1000);
    }
    if (error.reason === 'keyInvalid') {
      try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
    }
    error.message = apiMessage(error);
    throw error;
  }, {
    maxAttempts: 3,
    isStopped: () => stopped,
    sleep: abortableSleep
  });

  const progress = renderProgress(shell, stop);
  try {
    progress.update({ stage: 'Проверяю API key и данные видео…', requests: requestCount });
    const videoResponse = await apiGet('videos', { part: 'snippet,statistics', id: videoId });
    const video = videoResponse.items?.[0];
    if (!video) throw new Error('Видео не найдено через YouTube Data API.');
    if (settings.saveKey) {
      try { localStorage.setItem(STORAGE_KEY, settings.apiKey); } catch (_) {}
    }
    const reported = Number(video.statistics?.commentCount);
    const title = clean(video.snippet?.title) || document.title.replace(/\s*-\s*YouTube\s*$/i, '').trim() || 'YouTube video';
    const channel = clean(video.snippet?.channelTitle);
    const detailPrefix = settings.limit === 0 && Number.isFinite(reported) && reported >= 100000
      ? `Большая выгрузка: счётчик видео ${reported.toLocaleString('ru-RU')}. Остановить можно в любой момент.\n`
      : '';
    const collected = await collectComments({ ...settings, videoId }, apiGet, {
      isStopped: () => stopped,
      onProgress: snapshot => {
        const coverage = Number.isFinite(reported) && reported > 0 ? snapshot.counts.total / reported * 100 : null;
        progress.update({
          stage: snapshot.stage === 'replies' ? 'Догружаю ответы ветки…' : 'Обрабатываю комментарии…',
          top: snapshot.counts.top,
          replies: snapshot.counts.replies,
          requests: requestCount,
          coverage,
          detail: `${detailPrefix}Страниц веток: ${snapshot.diagnostics.threadPages}\nСтраниц ответов: ${snapshot.diagnostics.replyPages}\nКвота: около ${formatPercent(requestCount / DAILY_QUOTA_BASELINE * 100)} от стандартных 10 000 ед.`
        });
      }
    });
    collected.diagnostics.requestCount = requestCount;
    if (!collected.records.length) {
      renderError(shell, 'Комментарии не получены', collected.error || (stopped ? 'Экспорт остановлен до получения первой страницы.' : 'API вернул пустой список комментариев.'));
      return;
    }
    const model = {
      meta: {
        title,
        channel,
        videoId,
        canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
        exportedAt: new Date().toISOString(),
        reportedCommentCount: Number.isFinite(reported) ? reported : null
      },
      settings,
      diagnostics: collected.diagnostics,
      stopped: collected.stopped,
      error: collected.error,
      records: collected.records
    };
    const date = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const mode = settings.order === 'time' ? 'FULL' : 'RELEVANCE';
    const partial = model.stopped || model.error ? ' PARTIAL' : '';
    const stem = `${safeFileName(title)} - YouTube Comments API v6 ${mode}${partial} - ${date}`;
    const files = [];
    if (settings.formats.includes('txt')) files.push({ filename: `${stem}.txt`, content: buildTextExport(model), mime: 'text/plain;charset=utf-8', bom: true });
    if (settings.formats.includes('md')) files.push({ filename: `${stem}.md`, content: buildMarkdownExport(model), mime: 'text/markdown;charset=utf-8', bom: true });
    if (settings.formats.includes('json')) files.push({ filename: `${stem}.json`, content: buildJsonExport(model), mime: 'application/json;charset=utf-8', bom: true });
    if (settings.formats.includes('csv')) files.push({ filename: `${stem}.csv`, content: buildCsvExport(model), mime: 'text/csv;charset=utf-8', bom: false });
    renderResult(shell, { files, archiveName: stem, counts: getModelCounts(model), requestCount, stopped: model.stopped, error: model.error });
  } catch (error) {
    if (error?.name === 'AbortError') renderError(shell, 'Экспорт остановлен', 'Данные не успели получить до остановки.');
    else renderError(shell, 'Экспорт не выполнен', apiMessage(error));
  } finally {
    activeController = null;
  }
})();
