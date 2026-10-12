# Video Bulk Downloader

A Chrome and Firefox extension for downloading videos in bulk. Paste video page links, check the quality and file names, then download. Both browser packages use the same application and queue logic.

The extension supports the single video site configured in `manifest.json` and `shared.js`. It accepts that site's video page URLs; it does not discover videos from arbitrary websites, channel pages, or playlist pages.

- Picks the highest resolution at or below your quality limit (unlimited by default), preferring your codec choice (AV1 by default, H.264 optional) only at the same resolution. Available resolutions depend on the video and the page returned by the site. Each queued job captures its quality settings; changing the limit or codec affects future work, refreshes a ready link when needed, and never overwrites your edited file names. An unsatisfiable limit is reported explicitly so you can raise it and retry.
- Lets you rename every file before it is saved.
- Optional save dialog for each file, or direct saves into a folder.
- Choose 1–10 concurrent downloads in Settings; the default is 3, shared across normal and private windows. Each file has its own status.
- Each downloading file shows a progress bar, percentage, received/total size, recent transfer speed, and ETA. Progress refreshes about once per second while the downloader tab is visible; unknown file sizes show an indeterminate bar and the received byte count. ETA is unavailable when size/speed is unknown, the transfer is stalled, or it is paused.
- Downloads continue after closing the downloader tab. The queue and edited names are stored locally and restored when you reopen it.
- Failed files can be selected and retried without replacing the table.
- Cancel queued or active downloads individually, remove rows, and re-download saved entries from history.
- Normal and private windows have separate pasted URLs, found lists, quality/save settings, tags, and history. The downloader tab's browsing mode determines the session used for video transfers; private page discovery runs without login cookies.
- Found videos and saved history have separate sections, select-all checkboxes, pagination with search/filter/sort controls, and JSON/TXT import and export controls. Row actions use icons with tooltips and accessible labels, including pause, resume, and show-in-folder controls where available.
- Reusable author and channel tags can be imported and exported as JSON or TXT. Hover or focus a video title in either section to preview its thumbnail.
- Export and restore a full JSON backup of both sessions, including lists, saved history, drafts, tags, thumbnails, and settings.

> This project is not affiliated with Mozilla or any other sites. You are responsible for following the site's terms and the copyright rules where you live. Only download content you have the right to download.

## Requirements

- Firefox 142 or newer, or Chrome 120 or newer (desktop).
- Video page URLs from the configured site, with site access granted to the extension.
- When the site requires an account for a video or resolution, log in within the same browser profile and browsing mode used for the download. Private page discovery still runs without login cookies, so logging in privately does not unlock additional resolutions in its lookup results.
- For private downloads, enable **Run in Private Windows → Allow** in Firefox's Add-ons Manager, or **Allow in Incognito** on the extension's details page in Chrome. Open the downloader from its toolbar icon in a private/incognito window, and keep a private window open during the batch.

## Install

### Chrome

1. Install Node.js 18 or newer for the build tooling, then run `npm run build:chrome` from the project root. No dependency installation is needed for building or running unit tests.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the generated `dist/chrome` directory.
4. Click the extension's toolbar icon to open the downloader. Pin the icon if needed. For incognito downloads, open **Details**, enable **Allow in Incognito**, and use the icon from an incognito window.

After editing the source, rebuild and click **Reload** on the extension's card. Chrome's unpacked installation persists across browser restarts. The generated Chrome ZIP is the package for a Chrome Web Store submission; it is not installed through **Load unpacked**. Store publication is a separate step.

### Firefox: permanent installation without a public store listing

Mozilla can sign this extension for **self-distribution (unlisted)**. It stays out of the public add-on store. See Mozilla's [signing overview](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/) and [self-distribution submission guide](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/#self-distribution).

1. Run `npm run build:firefox` from the project root to generate the Firefox directory and unsigned ZIP under `dist/`. The ZIP contains `manifest.json` at its root. Keep the add-on ID `video-bulk-downloader@local` when signing later versions.
2. Sign in with a Mozilla account at the [Add-ons Developer Hub](https://addons.mozilla.org/developers/), choose **Submit a New Add-on**, then **On your own**.
3. Upload the ZIP, follow validation and submission prompts, and wait for signing. This repository contains readable JavaScript; no compiled or minified source package is needed for these files. If you later add a build step or minified dependencies, follow the source-submission requirements.
4. Download the **signed XPI** from the version details. Install that file in Firefox through `about:addons` → settings cog → **Install Add-on From File…** → **Add**. It then persists across browser restarts. See Mozilla's [install-from-file instructions](https://extensionworkshop.com/documentation/publish/install-self-distributed/).
5. For an update, increase the manifest version, submit it under the same add-on and unlisted channel, download the newly signed XPI, and install it over the existing version. This manifest has no update URL, so these updates are manual.

Export a full backup before replacing a temporary installation. The unsigned ZIP is for submission; use Mozilla's signed XPI for the permanent installation.

### Firefox: temporary development installation

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select the root `manifest.json`, or build with `npm run build:firefox` and select `dist/firefox/manifest.json`.
3. Click the extension's toolbar icon to open the downloader tab.

Firefox removes temporary add-ons when it closes, so load it again after a restart.

For unsigned installation outside the temporary loader, Firefox Developer Edition and Nightly support setting `xpinstall.signatures.required` to `false` in `about:config`. Standard Firefox release and beta require a signed extension; see Mozilla's [signing requirements](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/#signing-your-add-ons).

## Usage

1. Paste one or more video page URLs, one per line or separated by whitespace. Only the configured site's URLs with a `/video-…` path are accepted; links with credentials or non-default ports are rejected. HTTP and non-`www` links are normalized to HTTPS with `www`, and fragments are removed. Repeated videos are combined, and invalid entries are reported with examples.
2. Click **Find links**. New videos are added to the existing table, which shows each title, the chosen quality, and an editable file name. Repeated URLs for the same video, including different playlist queries, do not create duplicate rows.
3. Untick anything you don't want, and edit file names as needed.
4. Click **Download selected** in the Found videos toolbar. Hover over row action icons to see their labels.

The gear button on the right of the extension header opens **Settings**, with the save-dialog checkbox, concurrency limit, and full JSON backup actions. Changes save automatically. Close Settings with **Done**, Escape, or a click outside the dialog. Backup feedback appears inside Settings, and restoring a backup opens its replacement confirmation above it. Quality and Codec remain in the main toolbar.

You can close the tab while downloads run. The toolbar button reopens the saved table or focuses an existing downloader tab in the window it was clicked from. You can paste and find more links during downloads; existing finding, ready, queued, downloading, and saved entries remain in the table. Replacing or clearing the pasted text never removes rows or cancels transfers.

To retry a failed file, select it, check its name, and click **Download selected**, or use its row's **Retry download** action. Retries fetch fresh links and preserve your filename. Retrying an interrupted transfer starts a new download; it does not resume partial bytes. Existing files are protected by the browser's filename uniquifying behavior.

### Site permission onboarding

If site access is missing or has been revoked, click **Grant site access** in the banner above the URL box and accept the browser's permission prompt. The extension checks access before fetching pages.

### Quality settings

Choose **Quality max** to limit resolution, or **No limit** for the highest available resolution. Choose **Codec** to prefer AV1 or H.264 when both are available at that resolution. Resolution takes priority over codec preference. If no rendition meets the limit, raise the limit and retry.

Each queued job keeps the settings used when it was queued. Changing the settings affects future work. A ready link whose captured quality settings differ is refreshed when you next queue its download, and edited filenames are preserved.

Each row in **Found videos** and **Saved videos** also has a quality selector for its next download. Choose **Default** to follow Quality max, or choose a supported resolution from 480p upward to override it for that video. The extension reads all download renditions on the video page, including those above the global limit, and displays the highest available resolution. Older rows and imported saved entries have **Check qualities** to look up their available resolutions without downloading. Queued and active rows keep their captured settings; saved history retains the quality of each completed download. Fresh links are fetched when a new quality needs them.

An explicit row resolution requests that exact height. If it is no longer available when links are refreshed, the row fails instead of silently downloading a lower resolution. Use **Check qualities** and select another resolution or **Default** before retrying. The filename is preserved when quality changes, so update any quality label you put in the name yourself.

### Rename helper

Use **Reusable tags** on the right of the **Found videos** header to add reusable author and channel tags. Tags appear as chips; use a chip's × button to remove it from the reusable library. Removing a tag keeps existing filenames unchanged.

Close the tag manager with **Done**, Escape, or a click outside the dialog. Choose **JSON** or **TXT** in its **Tag file format** selector, then use **Export tags** or **Import tags** to transfer both libraries. Imports merge names, skip duplicates without regard to case, and leave video filenames unchanged. Invalid files or imports that exceed 100 tags per type are rejected as a whole. Tag names can contain up to 100 characters; import files can be up to 1 MiB. JSON tag files are separate from video-list exports.

TXT tag files have one name per line under `[Authors]` and `[Channels]` headings. Exported names beginning with a backslash or matching a heading are escaped with an extra backslash so they round-trip unchanged. For example:

```text
[Authors]
Alex
Morgan

[Channels]
Channel One
```

Click the **pencil** beside a video's filename to choose author chips and one channel chip. You can choose multiple authors, joined with ` & `, or click a selected chip again to clear it. **Apply tags** builds `Author Name - Video Title [Channel Name]`, preserving your current title, and selects the title in the filename input so you can type or edit it directly there. Reapplying or changing tags preserves title edits and replaces the previous tags without duplicating them. The picker also links to the tag manager when you need to add another name.

Tags are saved with the normal/private list, including when the list has no videos. Private tags are cleared when the last private window closes. Existing reusable names are kept when upgrading, and JSON exports preserve each video's selected naming fields. The same pencil is available on saved rows for their next download; the already-downloaded file and its recorded filename are kept.

### Concurrent downloads

Open **Settings** from the header gear and use **Concurrent downloads** to choose from 1 to 10 simultaneous video transfers; the default is 3. The setting is saved across restarts and shared by normal and private windows. Increasing it fills available slots immediately. Decreasing it keeps existing transfers running and waits until enough slots are free before starting another file. Paused downloads keep their slots. Save-dialog downloads remain sequential so multiple file prompts do not open together. Video-page discovery keeps its separate limit of three lookups.

### Full JSON backup and restore

Use **Export full backup** in **Settings** to download all saved extension data from both normal and currently open private sessions: found/saved lists, complete history metadata, pasted drafts, filenames and selected tags, reusable author/channel libraries, thumbnail URLs, quality/codec/save-dialog settings, the concurrency setting, and saved import progress. Normal and private data remain separate in the backup. The export includes private data while that session exists, so keep the backup somewhere appropriate for that data. Data already cleared when the last private window closed cannot be recovered by a later export.

Use **Restore backup**, choose a whole-extension JSON backup, review the summary, then click **Replace data and restore**. This replaces both sessions rather than merging them. It validates the entire file first and preserves the previous data if a storage write fails and rollback succeeds. If the browser cannot write the rollback either, the error tells you to keep the backup and retry after resolving the storage problem. Backups are limited to 50 MiB; they can restore accumulated libraries larger than a single video-list import, subject to browser storage capacity.

Finish or cancel all lookups, queued downloads, and active transfers in both sessions before restoring. Restoring private data also requires an open private/incognito window and permission for the extension to run there. Restored private data goes into session storage and clears when the last private window closes.

Backups contain extension data; they do not contain downloaded video files, partial files, browser cookies/logins, browser permissions, or the extension's code. Restoring does not automatically start downloads or reconnect to old transfer IDs. Backed-up active, queued, and finding rows become cancelled rows that you can retry explicitly. History timestamps, filenames, sizes, and qualities remain available, but **Show in folder** needs a new locally verified transfer. A retry obtains fresh download links. Existing files remain on disk.

### List controls and history

- **Clear pasted links** empties only the textarea. Pasted text is saved as you edit it, even before clicking Find links.
- **Cancel** stops one active transfer or prevents a queued file from starting. Cancelled rows remain available for retry. If the browser is still showing a Save As dialog, cancellation is requested and takes effect when that dialog is closed or the download ID becomes available.
- **Remove** removes one row and its extension history. An active transfer is cancelled first. Downloaded files and the browser's own download history are kept.
- **Download again** re-downloads a saved row after fetching fresh links. Its previous saved timestamps and filenames remain in the row's history; repeated completion events do not create duplicate history records.
- **Pause / resume** pauses or continues an active transfer. A paused transfer keeps its queue slot. Resume shows **Resuming…** until the browser reports that the transfer is running; other rows and controls remain usable during that request. A rejected resume keeps the paused row retryable and shows an error there. An interrupted or failed transfer instead uses **Retry download**, which starts a new download.
- **Show in folder** reveals a file from a successful local download while the browser still lists it under the name recorded when it finished. Imported history cannot be revealed. If the browser no longer matches a saved entry, that stale link is cleared and the file is not revealed.
- Search, status filters, and sorting help navigate each section. Choose 50 or 100 videos per page. Selection is kept when changing pages or filters.
- **Select all** selects every matching video across all pages in that section. Bulk actions affect selected videos matching the current filter, including other pages. A hint reports selections hidden by the filter. Exports always include the entire section.
- Hover over a video's title, or focus its link with the keyboard, to preview its thumbnail in either section. Images load on demand; older entries look up their thumbnail on first use without starting a download or changing their filename or history. Missing images show an unavailable message. Escape, leaving the link, scrolling, or changing pages hides the preview. Click the title to open its page in a new tab in the same browsing mode.

Completed videos move to the **Saved videos** section and remain there during re-downloads. Saved entries are not selected automatically, so downloading new found videos does not unexpectedly re-download history entries. Each queued job captures its save-dialog setting; changing the checkbox affects future jobs. The configured concurrency limit applies across both sessions, and save-dialog jobs run one at a time.

Click a row's empty area (or focus the row and press Space/Enter) to select or unselect it. Links, name inputs, and action buttons keep their own behavior. The select-all checkbox shows a partial-selection state when appropriate. Bulk **Cancel selected** and **Remove selected** skip videos already downloading or awaiting cancellation; individual row icons can still cancel or remove an active transfer.

The estimated time remaining appears next to the speed, without an ETA prefix. It is an estimate based on recent transfer speed and is unavailable for unknown sizes, stalls, and paused transfers.

### Import and export

Each section has a JSON/TXT format selector and its own Import and Export icons. Exports include all videos in that section for the current normal/private session.

Importing shows a loading indicator while reading the file, then a progress bar with the number of video lookups completed. It stays visible until all imported videos have been checked and reports lookup failures that can be retried. Progress is restored when you reopen the downloader. Saved imports finish after restoring the list and history. Export filenames include the date and UTC time through milliseconds, such as `found-videos-2026-10-10_14-32-05-123.json`, so repeated JSON/TXT exports on the same day have different names.

- **JSON** preserves page URLs, titles, thumbnails, filenames, quality, and saved timestamps/history. It excludes live download IDs, cookie data, and transfer state. Found and saved JSON exports must be imported into their corresponding sections.
- **TXT** contains one page URL per line. Found TXT imports look up fresh video information; saved TXT imports create labelled imported history entries without filenames or timestamps from the original download.
- Found imports fetch fresh links and preserve JSON filenames. They never start downloads automatically. Saved imports remain in the Saved videos section and can be downloaded again explicitly.
- Imported history shows its recorded size when available, otherwise **Imported history · size unknown**. Importing history does not verify that its files exist on this computer.
- Imports add entries and deduplicate by video ID. Existing saved entries and active jobs are kept. An idle found row can move to Saved when importing its saved entry. Invalid files are rejected before changing the lists.
- Import and find notices report metrics: new videos added, already-listed videos skipped, rejected tokens with bounded examples, and for imports the added/moved-to-saved/already-listed-or-active counts.
- Import files are limited to 5 MiB and 10,000 videos. Exporting a private list explicitly saves a file you can retain outside the private browsing session.

### Normal and private lists

Normal lists, drafts, and history are saved in local extension storage across browser restarts. Private lists use in-memory session storage and remain available across private windows and background-page reloads while a private window is open. Closing the last private window cancels remaining private jobs and clears its draft, list, settings, and history. Closing a normal window does not clear the private list while another private window remains open.

In Chrome, if the incognito worker shuts down before reporting the last window's closure, background checks clear the memory-only leftovers after two unanswered probes. This can take about two minutes. Opening a new incognito session clears the previous session before its commands run.

Pasted text and filename edits are saved after a short typing pause and before actions that need them. Draft text is stored separately so typing does not rewrite the whole video list. Existing drafts are migrated automatically.

The previous shared list is migrated using each transfer's recorded session when available. Previously saved rows remain in the appropriate list as history; private data is removed from the normal storage entry.

### Recovery and retries

The background queue reconciles saved transfers with the browser when it restarts. Download IDs can change or be reused, so recovery verifies the saved precise start time, URL, browsing mode, and filename when available before adopting a transfer. An already verified transfer can update its recorded start time when Firefox resumes it in the current session. Older rows without a saved identity can be upgraded only when the browser still identifies their transfer as belonging to this extension; otherwise, already-started work requires an explicit retry. Pending Save As dialogs wait for their own creation event without a timeout. Persisted lookups and queued work that had not launched can continue automatically after recovery.

In Chrome, a native transfer whose identity was not saved still reserves a concurrency slot until it finishes or is cancelled in the browser. Check the browser's download list before retrying an unverified row.

Temporary video-page network errors, timeouts, and HTTP 408/429/5xx responses receive up to 3 attempts. Each attempt has a 30-second timeout covering both the request and response body. Retries normally wait 400 ms, then 800 ms; a valid server `Retry-After` overrides this delay. A requested wait longer than 60 seconds is reported so you can retry later. Missing permissions, HTTP 401/403, page parsing errors, and unavailable quality limits require your attention. Cancelling a lookup also cancels its retry wait. Failed video transfers require an explicit retry and are not automatically restarted.

If saved extension storage cannot be read, commands are blocked while the existing data is kept. Retry after resolving the storage issue. Failed draft or filename saves retain the pending edit in the open tab and block actions that need it until it can be saved.

### Save options

| Option | Result |
| --- | --- |
| **Show save dialog for each file** on | The browser's Save As dialog opens for each file, one at a time. Choose the folder there. |
| Option off (default) | Files are saved in the `Video Bulk Downloads` subfolder of the browser's configured download directory (normally `Downloads\Video Bulk Downloads\`). The extension requests direct saving. |

File names initially use `Title [resolution codec].mp4`, such as `Title [2160p AV1].mp4`, based on the discovered link. You can edit the basename with or without `.mp4`; the downloader saves an `.mp4` file. If a file with the same name already exists, the new one gets a suffix such as `(1)`.

Invalid filename characters and leading/trailing dots are removed or replaced, whitespace is collapsed, and long basenames are truncated. Empty basenames, including `.mp4`, are rejected before the batch starts. Windows device names are prefixed with an underscore.

## Troubleshooting

| Message | Likely cause |
| --- | --- |
| No download links found | You're not logged in to the site of the pasted video URL in this browser profile, or the site changed its page layout. |
| No download links found on a private row | Private lookups send no login and read the public page only. Try the video in a normal window. |
| No download links at or below Np | Your quality limit excludes every available rendition. Raise the limit or choose unlimited, then retry. |
| Np is no longer available | The exact resolution selected for this row disappeared. Check qualities, choose another resolution or Default, then retry. |
| Site permission is required | Grant the site access from the downloader's permission prompt (it must come from a direct click), then retry. |
| N rejected / invalid URLs | Pasted text contained unsupported or malformed URLs. Use video page URLs from the configured site; the find notice includes bounded examples of rejected tokens. |
| HTTP 403 or HTTP 429 | The site is blocking or rate-limiting requests. Wait a few minutes and try fewer links. |
| Failed: … (on a download) | Check that you are still logged in, then retry the file. |
| Received text/html instead of a video | A login or error page was downloaded. Log in in the same normal/private browsing mode as the downloader tab. The error identifies that session. The invalid file may remain in Downloads; it is not counted as saved. |
| Previous download could not be verified | The saved transfer identity no longer matches a unique browser download. Check the browser's download list, then explicitly retry the row if needed. |
| Storage read failed. Retry this action. | Saved extension data could not be read. Existing data is kept and commands are blocked; resolve the storage issue and retry. |

Completed transfers are checked against their MIME type so HTML, JSON, and other obvious non-video responses are reported as failures. Servers that omit MIME metadata or declare generic binary content cannot be validated from this metadata alone.

The background queue reconciles saved download IDs with the browser when it restarts. Downloads interrupted by a browser restart remain retryable. Removing or disabling the extension stops queue processing; Firefox also removes temporary add-ons at shutdown.

## Project structure

```text
video-bulk-downloader-firefox-extension/
├── manifest.json   Firefox source manifest (Manifest V3)
├── manifest.chrome.json Chrome-specific manifest overlay
├── browser-compat.js Promise API and messaging compatibility
├── platform.js     Browser-specific background operations and parsing
├── service-worker.js Chrome background entry point
├── chrome-bridge.js Chrome normal/incognito coordination in session storage
├── offscreen.html / offscreen.js Chrome DOM parsing context
├── background.js   Owns discovery, the persistent queue, and download events
├── shared.js       URL/HTML parsing, quality and filename helpers, tags, list/backup formats, and response validation
├── app.html        Downloader page
├── app.css         Styles (light and dark themes)
├── app.js          Displays queue state and sends commands to the background
├── scripts/        Browser builds and real Chrome smoke checks
├── tests/          Node regression and browser compatibility suites
├── dist/           Generated browser directories and ZIPs (ignored by Git)
└── icons/          Extension icon SVG/PNG assets and actions.svg (row icons are drawn inline)
```

## Development

- Run `npm run build` to generate both browser packages, or `npm run build:chrome` / `npm run build:firefox` for one browser. Generated packages contain only runtime assets. Firefox development can also load the source manifest directly.
- Tests (Node.js 18+): run `npm test` or `node --test`. The suites cover queue recovery, transfer identity, private-session isolation, storage failures, quality selection, list/tag imports, backups, concurrency, UI behavior, API compatibility, and packaging. No dependency installation is needed.
- Real Chrome smoke checks: with Node.js 22+, OpenSSL, and [Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/), set `CHROME_PATH` to the test browser executable and run `node scripts/chrome-smoke.cjs`. Set `OPENSSL_PATH` if OpenSSL is not on PATH. The script builds the Chrome extension, uses an isolated temporary browser profile and local HTTPS fixtures, checks normal/incognito discovery and cookie separation, full backups, global concurrency, worker recovery with the UI closed, and private cleanup. It never downloads from the live video site. Ordinary branded Chrome restricts extension-loading command-line flags, so use Chrome for Testing for automation.
- Real Firefox smoke checks: set `FIREFOX_PATH` and `GECKODRIVER_PATH` to Firefox and [GeckoDriver](https://github.com/mozilla/geckodriver/releases), then run `node scripts/firefox-smoke.cjs`. It installs the generated package temporarily in a disposable headless profile and checks the UI, parser, normal/private drafts, full backups, and private cleanup without accessing the video site.
- Optional Firefox tooling (Node.js 22+ for current `web-ext`): build first, then run `npx web-ext lint --source-dir dist/firefox` or `npx web-ext run --source-dir dist/firefox`. See the [web-ext command reference](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/). Live-site behavior and native Save As dialogs still require manual verification in each browser.
- Firefox retains its add-on ID and declares `none` for data collection. The Chrome package removes Gecko-only metadata, uses a Manifest V3 service worker, and declares Chrome 120 as the minimum.

## Notes

- Links are read from the configured site's video-page HTML (`#hd-porn-dload`) and must match its expected MP4 download path and origin. If that markup changes, `parseVideoPage` in `shared.js` needs updating. Quality choice is highest height at or below `maxHeight` (0 = unlimited), then `preferredCodec` (`AV1` default, `H.264` optional) at equal resolution; an explicit row choice uses `exactHeight`.
- Pasted URLs are parsed with `parsePastedUrls(text)` into `{ urls, invalid, duplicateCount }`: whitespace-separated tokens are normalized, deduplicated by video ID, and rejected tokens are returned for bounded reporting.
- Draft keys `downloaderDraft` / `privateDownloaderDraft` hold `{ input, inputRevision }` separately from the video lists. Row icons `pause`, `play`, and `folder` are drawn inline by `createActionIcon`.
- Video transfers automatically use the downloader tab's normal or private browser session. Normal page discovery includes normal-session cookies. Private discovery omits cookies and bypasses the HTTP cache, including for quality and thumbnail lookups. A logged-out view can list fewer resolutions, so a private row may pick a lower resolution than a normal row for the same video. Requests for pages, previews, and media go to the configured site and its media hosts.
- Chrome uses split incognito mode so the downloader can open in an incognito tab. A single normal worker owns both queues; the incognito worker relays commands and performs private browser operations through memory-only session storage. This keeps concurrency and full backups shared while private transfers use incognito cookies. Chrome parses fetched HTML in a packaged offscreen document and uses alarms to recover pending work after worker shutdown.
- The extension requests `downloads` and `storage`, with host access limited to the configured site's HTTPS `www` origin. Normal state uses `browser.storage.local`; private state uses `browser.storage.session` and is cleared when the last private window closes. Neither is synced or sent to an analytics service. The manifest declares no data collection for Mozilla's consent system.
