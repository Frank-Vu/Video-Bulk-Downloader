/* Chrome uses one queue coordinator and a separate incognito API relay. */
importScripts('browser-compat.js', 'shared.js', 'platform.js', 'chrome-bridge.js');
if (VideoDownloaderPlatform.role === 'normal') importScripts('background.js');
VideoDownloaderBridge.start().catch((error) => console.error('Video Bulk Downloader:', error));
