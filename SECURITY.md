# Security and privacy

## Supported versions

Security fixes are applied to the current Comments v6 and Transcript v3 source files in the default branch.

## Reporting a vulnerability

Please open a GitHub security advisory through **Security → Advisories → Report a vulnerability**. Do not publish API keys, private video URLs, exported comments, transcripts, or other personal data in a public issue.

## Data flow

- Comments v6 talks only to `www.googleapis.com/youtube/v3` and uses a user-provided YouTube Data API v3 key.
- Transcript v3 reads the current YouTube page and YouTube player/caption endpoints.
- No analytics, remote logging, proxy, MCP service, external ZIP library, or project-owned backend is used.
- Exported data stays in browser memory until the user downloads it.

Comments v6 can optionally store the API key in `localStorage` for the `youtube.com` origin. This is convenient, but scripts and browser extensions with access to the same origin may be able to read it. For stronger privacy, leave “save key” disabled and restrict the key to YouTube Data API v3 and appropriate website referrers in Google Cloud Console.

Before running any DevTools snippet or bookmarklet, review the readable `.js` source. Never paste code from an untrusted source into DevTools.
