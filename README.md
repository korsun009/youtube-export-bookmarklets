# YouTube Comments Exporter & Transcript Downloader

![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f.svg)
![JavaScript](https://img.shields.io/badge/JavaScript-bookmarklet-f7df1e.svg)
![No backend](https://img.shields.io/badge/backend-not%20required-4c8bf5.svg)

Два автономных инструмента для локального экспорта данных YouTube прямо из браузера:

- **YouTube Comments Exporter v6** — комментарии и ответы в TXT, Markdown (`.md`), JSON и CSV через официальный YouTube Data API v3.
- **YouTube Transcript & Subtitle Exporter v3** — открытая расшифровка и дорожки субтитров в TXT, SRT и VTT.

Каждый инструмент запускается как **bookmarklet / JavaScript-закладка** или как постоянный **Chrome DevTools Snippet**. Сервер, расширение браузера и установка npm-пакетов для обычного использования не нужны. Все подготовленные файлы можно скачать по одному либо одной кнопкой в ZIP.

> English search summary: open-source YouTube comments exporter, YouTube transcript downloader, subtitle downloader, bookmarklet and Chrome DevTools snippet. Export YouTube comments to Markdown, JSON, CSV or TXT and subtitles to SRT, VTT or TXT.

## Что выбрать

| Задача | Инструмент | Результаты |
|---|---|---|
| Архивировать публичные комментарии и ответы | Comments v6 | TXT, MD, JSON, CSV, ZIP |
| Сохранить текст открытой панели «Расшифровка» | Transcript v3 | TXT с таймкодами или без них, ZIP |
| Получить доступные дорожки субтитров | Transcript v3 | TXT, SRT, VTT, ZIP |

## Быстрая установка как закладки

Этот вариант удобен для ежедневного запуска одним нажатием.

1. Откройте менеджер закладок браузера. В Chrome, Edge и Яндекс Браузере обычно используется `Ctrl+Shift+O`.
2. Создайте новую закладку.
3. Для комментариев откройте [youtube-comments-api-bookmarklet-v6.txt](youtube-comments-api-exporter-v6/youtube-comments-api-bookmarklet-v6.txt), а для расшифровок — [youtube-transcript-subtitle-bookmarklet-v3.txt](youtube-transcript-subtitle-exporter-v3/youtube-transcript-subtitle-bookmarklet-v3.txt).
4. Нажмите **Raw**, скопируйте всю единственную строку вместе с началом `javascript:` и вставьте её в поле URL закладки.
5. Назовите закладку, например `YouTube — комментарии` или `YouTube — расшифровка`.
6. Откройте конкретное видео на `youtube.com` и нажмите созданную закладку.

Если браузер удалил начало `javascript:`, впишите его в поле URL вручную и снова сохраните закладку. Не запускайте код из неизвестных источников — читаемые исходники находятся рядом с bookmarklet-файлами.

## Постоянный запуск через DevTools Snippets

Snippet хранится в профиле Chromium-браузера и остаётся доступным после перезапуска. Это удобно, если браузер ограничивает длинные URL закладок или вы хотите запускать читаемый исходный код.

1. Откройте страницу видео YouTube.
2. Нажмите `F12` или `Ctrl+Shift+I`.
3. Перейдите в **Sources / Источники**.
4. В левой панели выберите **Snippets / Фрагменты**. Если вкладки не видно, откройте меню `»` или нажмите `Ctrl+Shift+P` и найдите `Show Snippets`.
5. Нажмите **New snippet** и задайте понятное имя.
6. Скопируйте весь читаемый исходник:
   - [youtube-comments-api-exporter-v6.js](youtube-comments-api-exporter-v6/youtube-comments-api-exporter-v6.js);
   - [youtube-transcript-subtitle-exporter-v3.js](youtube-transcript-subtitle-exporter-v3/youtube-transcript-subtitle-exporter-v3.js).
7. Вставьте код, сохраните через `Ctrl+S`.
8. Запускайте сохранённый snippet через `Ctrl+Enter` или команду **Run** в контекстном меню.

Некоторые версии DevTools показывают защитное предупреждение при первой вставке. Прочитайте код и следуйте только штатной подсказке самого браузера. Snippets локальны для конкретного профиля: при очистке профиля или переходе на другой компьютер их нужно добавить заново.

## Comments Exporter v6

Функции:

- официальный `videos.list`, `commentThreads.list` и `comments.list`;
- ответы, догрузка неполных веток и устранение дублей;
- сортировка `time` или `relevance`;
- лимит по основным комментариям либо по общему числу сообщений;
- остановка активного запроса с сохранением уже собранного результата;
- retry для временных HTTP-ошибок с учётом `Retry-After`;
- TXT для чтения, Markdown для Obsidian/Notion/GitHub и баз знаний, JSON для программной обработки, CSV для таблиц;
- защита CSV от formula injection;
- отдельные файлы или один ZIP без сторонней библиотеки.

### API key

Comments v6 требует ключ YouTube Data API v3:

1. Создайте проект в Google Cloud Console.
2. Включите **YouTube Data API v3**.
3. Создайте API key в разделе Credentials.
4. Рекомендуется ограничить ключ только YouTube Data API v3 и разрешёнными HTTP referrers `https://www.youtube.com/*` и при необходимости `https://youtube.com/*`.
5. Вставьте ключ в графическую панель. Сохранение в браузере необязательно.

Ключ не записывается в файлы экспорта. Запросы расходуют квоту Google Cloud; ответы могут потребовать дополнительные страницы `comments.list`. Режим `relevance` является выборкой лучших веток и не доказывает полный обход.

## Transcript & Subtitle Exporter v3

Функции:

- чтение уже открытой панели расшифровки YouTube;
- поддержка современного и старого DOM, открытых Shadow DOM и виртуализированной прокрутки;
- поиск ручных и автоматических дорожек в текущем player response и резервных профилях;
- разбор XML, SRV3, JSON3, VTT и SRT;
- TXT с таймкодами, TXT без таймкодов, SRT и VTT;
- несколько источников, дорожек и форматов за один запуск;
- отдельные файлы или один ZIP;
- безопасная работа на страницах с Trusted Types — без `innerHTML` и системных модальных окон.

Чтобы прочитать именно панель, сначала вручную откройте под видео **Показать расшифровку** и дождитесь строк. Скрипт не нажимает кнопки YouTube самостоятельно.

## Возможные проблемы

### Закладка ничего не делает

- Проверьте, что URL закладки начинается с `javascript:`.
- Запускайте её на странице конкретного видео, Shorts или live-записи на `youtube.com`.
- Если политика браузера ограничивает длинную закладку, используйте DevTools Snippet.

### Comments v6 сообщает об API key или quota

- Убедитесь, что YouTube Data API v3 включён в том же Google Cloud project.
- Проверьте ограничения ключа и HTTP referrer.
- Ошибки `quotaExceeded` означают, что дневная квота проекта исчерпана.
- Закрытые, удалённые, удерживаемые и отключённые комментарии API не возвращает.

### Панель расшифровки не найдена

- Сначала откройте «Показать расшифровку» вручную.
- Дождитесь появления строк и повторите запуск.
- Интерфейс YouTube меняется; приложите URL типа страницы, текст ошибки и браузер к GitHub Issue, но не публикуйте приватные данные.

### Дорожка субтитров возвращает 403 или пустой ответ

YouTube может требовать video-bound PO Token, менять внутренний player API или ограничивать возрастные, региональные и закрытые видео. v3 пробует несколько доступных источников, но не обходит anti-abuse. В таком случае экспорт уже открытой панели расшифровки остаётся независимым вариантом.

### ZIP почти не уменьшил размер

Архив создаётся автономным ZIP STORE writer без CDN и внешних зависимостей. Он объединяет файлы в один корректный ZIP, но не обязан заметно сжимать уже небольшие текстовые файлы.

## Приватность

- Собственного сервера, аналитики и телеметрии нет.
- Comments v6 обращается к YouTube Data API; Transcript v3 — к странице и ресурсам YouTube.
- Файлы формируются в памяти браузера и скачиваются только по нажатию пользователя.
- Комментарии и расшифровки могут содержать публичные персональные данные — соблюдайте правила платформы и применимое законодательство.
- Подробности: [SECURITY.md](SECURITY.md).

## Разработка

Требуется Node.js 22+ только для тестов и сборки:

```powershell
npm test
npm run build
```

Сборщик превращает читаемые IIFE-файлы в однострочные `javascript:` bookmarklet. Автоматические тесты проверяют пагинацию, лимиты, форматы, ZIP, парсеры субтитров, отмену, Trusted Types и отсутствие API key в экспорте.

## Лицензия

[MIT](LICENSE). Проект не связан с YouTube или Google. YouTube является товарным знаком Google LLC.
