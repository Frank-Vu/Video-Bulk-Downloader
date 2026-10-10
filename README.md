# Video Bulk Downloader

A Firefox extension for downloading videos in bulk. Paste video page links, check the quality and file names, then download.

- Picks the highest resolution at or below your quality limit (unlimited by default; 2160p / 4K on most videos), preferring your codec choice (AV1 by default, H.264 optional) only at the same resolution. Each queued job captures its quality settings; changing the limit or codec affects future work, refreshes a ready link when needed, and never overwrites your edited file names. An unsatisfiable limit is reported explicitly so you can raise it and retry.
- Lets you rename every file before it is saved.
- Optional save dialog for each file, or direct saves into a folder.
- Choose 1–10 concurrent downloads in Settings; the default is 3, shared across normal and private windows. Each file has its own status.
- Each downloading file shows a progress bar, percentage, received/total size, recent transfer speed, and ETA. Progress refreshes about once per second while the downloader tab is visible; unknown file sizes show an indeterminate bar and the received byte count. ETA is unavailable when size/speed is unknown, the transfer is stalled, or it is paused.
- Downloads continue after closing the downloader tab. The queue and edited names are stored locally and restored when you reopen it.
- Failed files can be selected and retried without replacing the table.
- Cancel queued or active downloads individually, remove rows, and re-download saved entries from history.
- Normal and private windows have separate pasted URLs, found lists, save settings, and history. The login session is detected automatically from the downloader tab.
- Found videos and saved history have separate sections, select-all checkboxes, pagination with search/filter/sort controls, and JSON/TXT import and export controls. Row actions use icons with tooltips and accessible labels, including pause, resume, and show-in-folder controls where available.
- Reusable author and channel tags can be imported and exported as JSON or TXT. Hover or focus a video title in either section to preview its thumbnail.
- Export and restore a full JSON backup of both sessions, including lists, saved history, drafts, tags, thumbnails, and settings.

> This project is not affiliated with Mozilla or any other sites. You are responsible for following the site's terms and the copyright rules where you live. Only download content you have the right to download.

## Requirements

- Firefox 142 or newer (desktop)
- Account for any site that required to download, logged in within the same Firefox profile when required. Downloads of 1080p and above may redirect to the login page when you are logged out.
- If you log in in a private window, enable **Run in Private Windows → Allow** for this extension in Firefox's Add-ons Manager and open the downloader in that private window. Keep a private window open during the batch. No session checkbox is needed.

## Install

### Permanent installation without a public store listing

Mozilla can sign this extension for **self-distribution (unlisted)**. It stays out of the public add-on store. See Mozilla's [signing overview](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/) and [self-distribution submission guide](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/#self-distribution).

1. Package the extension with `npx web-ext build --ignore-files tests/** README.md`, or use the prepared ZIP in `web-ext-artifacts`. The ZIP must contain `manifest.json` at its root. Keep the add-on ID `video-bulk-downloader@local` when signing later versions.
2. Sign in with a Mozilla account at the [Add-ons Developer Hub](https://addons.mozilla.org/developers/), choose **Submit a New Add-on**, then **On your own**.
3. Upload the ZIP, follow validation and submission prompts, and wait for signing. This repository contains readable JavaScript; no compiled or minified source package is needed for these files. If you later add a build step or minified dependencies, follow the source-submission requirements.
4. Download the **signed XPI** from the version details. Install that file in Firefox through `about:addons` → settings cog → **Install Add-on From File…** → **Add**. It then persists across browser restarts. See Mozilla's [install-from-file instructions](https://extensionworkshop.com/documentation/publish/install-self-distributed/).
5. For an update, increase the manifest version, submit it under the same add-on and unlisted channel, download the newly signed XPI, and install it over the existing version. This manifest has no update URL, so these updates are manual.

Export a full backup before replacing a temporary installation. The unsigned ZIP is for submission; use Mozilla's signed XPI for the permanent installation.

### Temporary development installation

### Temporary (for development and testing)

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select `manifest.json` in this folder.
3. Click the extension's toolbar icon to open the downloader tab.

Firefox removes temporary add-ons when it closes, so load it again after a restart.

### Permanent

Firefox only keeps add-ons that are signed by Mozilla. Either submit the add-on to addons.mozilla.org as an unlisted add-on, or use Firefox Developer Edition or Nightly and set `xpinstall.signatures.required` to `false` in `about:config`.

## Usage

1. Paste one or more video page URLs, one per line. HTTP and non-`www` links are normalized to HTTPS. Repeated videos are combined, and invalid entries are reported with examples.
2. Click **Find links**. New videos are added to the existing table, which shows each title, the chosen quality, and an editable file name. Repeated URLs for the same video, including different playlist queries, do not create duplicate rows.
3. Untick anything you don't want, and edit file names as needed.
4. Click **Download selected** in the Found videos toolbar. Hover over row action icons to see their labels.

The gear button on the right of the extension header opens **Settings**, with the save-dialog checkbox, concurrency limit, and full JSON backup actions. Changes save automatically. Close Settings with **Done**, Escape, or a click outside the dialog. Backup feedback appears inside Settings, and restoring a backup opens its replacement confirmation above it. Quality and Codec remain in the main toolbar.

You can close the tab while downloads run. The toolbar button reopens the saved table or focuses an existing downloader tab in the window it was clicked from. You can paste and find more links during downloads; existing finding, ready, queued, downloading, and saved entries remain in the table. Replacing or clearing the pasted text never removes rows or cancels transfers.

To retry a failed file, select it, check its name, and click **Download selected**, or use its row's **Retry download** action. Retries fetch fresh links and preserve your filename. Retrying an interrupted transfer starts a new download; it does not resume partial bytes. Existing files are protected by Firefox's filename uniquifying behavior.

### Site permission onboarding

If site access is missing, click **Grant site access** in the banner above the URL box and accept Firefox's permission prompt. This is needed on older Firefox versions and whenever site access has been revoked. The extension checks access before fetching pages.

### Quality settings

Choose **Quality max** to limit resolution, or **No limit** for the highest available resolution. Choose **Codec** to prefer AV1 or H.264 when both are available at that resolution. Resolution takes priority over codec preference. If no rendition meets the limit, raise the limit and retry.

Each queued job keeps the settings used when it was queued. Changing the settings affects future work. Ready links are refreshed when their quality settings change, and edited filenames are preserved.

Each row in **Found videos** and **Saved videos** also has a quality selector for its next download. Choose **Default** to follow Quality max, or choose a supported resolution from 480p upward to override it for that video. The extension reads all download renditions on the video page, including those above the global limit, and displays the highest available resolution. Older rows and imported saved entries have **Check qualities** to look up their available resolutions without downloading. Queued and active rows keep their captured settings; saved history retains the quality of each completed download. Fresh links are fetched when a new quality needs them.

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

Use **Restore backup**, choose a whole-extension JSON backup, review the summary, then click **Replace data and restore**. This replaces both sessions rather than merging them. It validates the entire file first and preserves the previous data if a storage write fails and rollback succeeds. If Firefox cannot write the rollback either, the error tells you to keep the backup and retry after resolving the storage problem. Backups are limited to 50 MiB; they can restore accumulated libraries larger than a single video-list import.

Finish or cancel all lookups, queued downloads, and active transfers in both sessions before restoring. Restoring private data also requires an open private Firefox window and permission for the extension to run there. Restored private data goes into session storage and clears when the last private window closes.

Backups contain extension data; they do not contain downloaded video files, partial files, Firefox cookies/logins, browser permissions, or the extension's code. Restoring does not automatically start downloads or reconnect to old Firefox transfer IDs. Backed-up active, queued, and finding rows become cancelled rows that you can retry explicitly. History timestamps, filenames, sizes, and qualities remain available, but **Show in folder** needs a new locally verified transfer. A retry obtains fresh download links. Existing files remain on disk.

### List controls and history

- **Clear pasted links** empties only the textarea. Pasted text is saved as you edit it, even before clicking Find links.
- **Cancel** stops one active transfer or prevents a queued file from starting. Cancelled rows remain available for retry. If Firefox is still showing a Save As dialog, cancellation is requested and takes effect when that dialog is closed or the download ID becomes available.
- **Remove** removes one row and its extension history. An active transfer is cancelled first. Downloaded files and Firefox's own download history are kept.
- **Download again** re-downloads a saved row after fetching fresh links. Its previous saved timestamps and filenames remain in the row's history; repeated completion events do not create duplicate history records.
- **Pause / resume** pauses or continues an active transfer. A paused transfer keeps its queue slot. Resume shows **Resuming…** until Firefox reports that the transfer is running; other rows and controls remain usable during that request. A rejected resume keeps the paused row retryable and shows an error there. An interrupted or failed transfer instead uses **Retry download**, which starts a new download.
- **Show in folder** reveals a file from a successful local download while Firefox still lists it under the name recorded when it finished. Imported history cannot be revealed. If Firefox no longer matches a saved entry, that stale link is cleared and the file is not revealed.
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

Pasted text and filename edits are saved after a short typing pause and before actions that need them. Draft text is stored separately so typing does not rewrite the whole video list. Existing drafts are migrated automatically.

The previous shared list is migrated using each transfer's recorded session when available. Previously saved rows remain in the appropriate list as history; private data is removed from the normal storage entry.

### Recovery and retries

The background queue reconciles saved download IDs with Firefox when it restarts (see Troubleshooting). Firefox reassigns download IDs on restart and forgets which extension started each transfer, so each launch persists that transfer's exact identity (precise start time plus URL, browsing mode, and filename). A restored ID is trusted only against that fingerprint; a reused ID or a manual same-URL download (even a day later) is never adopted, and pause/cancel/resume never control an unverified transfer. Rows without that identity (pre-fix records) are handled conservatively: they are never matched by URL/time and never auto-launch a duplicate, instead requiring an explicit retry. Pending Save As dialogs wait indefinitely for their own creation event rather than any time window. Temporary video-page network errors, timeouts, and HTTP 408/429/5xx responses receive up to 3 attempts with a delay. Server retry instructions are respected; long requested delays are reported so you can retry later. Missing permissions, HTTP 401/403, page parsing errors, and unavailable quality limits require your attention. Cancelling a lookup also cancels its retry wait.

### Save options

| Option | Result |
| --- | --- |
| **Show save dialog for each file** on | Firefox's Save As dialog opens for each file, one at a time. Choose the folder there. |
| Option off (default) | Files are saved straight to `Downloads\Video Bulk Downloads\` (or whichever folder is set under Firefox's *Settings → General → Downloads → Save files to*). Firefox's "Always ask" setting is not used. |

File names default to `Title [2160p AV1].mp4`. If a file with the same name already exists, the new one gets a suffix such as `(1)`.

Invalid filename characters and leading/trailing dots are removed or replaced. Empty basenames, including `.mp4`, are rejected before the batch starts. Windows device names are prefixed with an underscore.

## Troubleshooting

| Message | Likely cause |
| --- | --- |
| No download links found | You're not logged in to the site of the pasted video URL in this Firefox profile, or the site changed its page layout. |
| No download links found on a private row | Private lookups send no login and read the public page only. Try the video in a normal window. |
| No download links at or below Np | Your quality limit excludes every available rendition. Raise the limit or choose unlimited, then retry. |
| Site permission is required | Grant the site access from the downloader's permission prompt (it must come from a direct click), then retry. |
| N rejected / invalid URLs | Pasted text contained incorrect site's tokens. The find notice names the rejected count with bounded examples; only normalized site URLs are queued. |
| HTTP 403 or HTTP 429 | The site is blocking or rate-limiting requests. Wait a few minutes and try fewer links. |
| Failed: … (on a download) | Check that you are still logged in, then retry the file. |
| Received text/html instead of a video | A login or error page was downloaded. Log in in the same normal/private browsing mode as the downloader tab. The error identifies that session. The invalid file may remain in Downloads; it is not counted as saved. |

Completed transfers are checked against their MIME type so HTML, JSON, and other obvious non-video responses are reported as failures. Servers that omit MIME metadata or declare generic binary content cannot be validated from this metadata alone.

The background queue reconciles saved download IDs with Firefox when it restarts. Downloads interrupted by a browser restart remain retryable. Removing or disabling the extension stops queue processing; Firefox also removes temporary add-ons at shutdown.

## Project structure

```text
video-bulk-downloader-firefox-extension/
├── manifest.json   Extension manifest (Manifest V3)
├── background.js   Owns discovery, the persistent queue, and download events
├── shared.js       URL, filename, HTML parsing, quality options, pasted-URL parsing, draft keys, icons, and response validation
├── app.html        Downloader page
├── app.css         Styles (light and dark themes)
├── app.js          Displays queue state and sends commands to the background
├── tests/          Node tests using mocked Firefox APIs (regression plus per-area improvement suites)
└── icons/          Extension icons: icon.svg (source) and PNG sizes
```

## Development

- There is no build step. Edit the files, then reload the add-on in `about:debugging`.
- Syntax checks: `node --check shared.js`, `node --check background.js`, and `node --check app.js`.
- Regression tests (Node.js 18+): `node --test tests/*.test.cjs`.
- Optional, requires Node.js: `npx web-ext lint --ignore-files "tests/**"` runs Mozilla's add-on linter, and `npx web-ext run --ignore-files "tests/**"` launches Firefox with the add-on loaded and reloads it on changes. Use the same exclusion when packaging with `web-ext build`.
- The declared minimum is Firefox 142, covering the manifest's data-consent metadata and site-permission API requirements in Mozilla's desktop and Android compatibility checks. Desktop Firefox is the supported installation target. The manifest keeps the `none` data-collection declaration. See [Mozilla's data-consent compatibility guidance](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/).

## Notes

- Links are read from each video page's HTML (`#hd-porn-dload`). If any site changes that markup, `parseVideoPage` in `shared.js` needs updating. Quality choice is highest height at or below `maxHeight` (0 = unlimited), then `preferredCodec` (`AV1` default, `H.264` optional) at equal resolution; see `normalizeQualityOptions`.
- Pasted URLs are parsed with `parsePastedUrls(text)` into `{ urls, invalid, duplicateCount }`: whitespace-separated tokens are normalized, deduplicated by video ID, and rejected tokens are returned for bounded reporting.
- Draft keys `downloaderDraft` / `privateDownloaderDraft` hold `{ input, inputRevision }` separately from the video lists. Row icons `pause`, `play`, and `folder` are drawn inline by `createActionIcon`.
- Video transfers automatically use the downloader tab's normal or private Firefox session. Normal page discovery reads the site's public video-page HTML with the background page's normal session. Private discovery reads the same public HTML without cookies and without the HTTP cache, so your normal login is never sent for a private video. A logged-out view can list fewer resolutions, so a private row may pick a lower resolution than a normal row for the same video. Nothing is sent to other services.
- The extension requests `downloads` and `storage`, with host access limited to sites set in this extension. Normal state uses `browser.storage.local`; private state uses `browser.storage.session` and is cleared when the last private window closes. Neither is synced or sent to an analytics service. The manifest declares no data collection for Mozilla's consent system.
