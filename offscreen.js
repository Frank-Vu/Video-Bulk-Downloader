/* DOMParser lives here because Chrome service workers have no DOM. */
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== browser.runtime.id || message?.target !== 'video-parser') return;
  try {
    if (typeof message.text !== 'string' || typeof message.baseUrl !== 'string') {
      throw new Error('Invalid video page parsing request.');
    }
    const value = message.thumbnailOnly
      ? { thumbnail: VideoDownloader.parseThumbnail(message.text, message.baseUrl) }
      : VideoDownloader.parseVideoPage(message.text, message.baseUrl, message.quality);
    sendResponse({ ok: true, value });
  } catch (error) {
    sendResponse({ ok: false, error: error.message || String(error),
      ...(error.availableHeights ? { availableHeights: error.availableHeights } : {}) });
  }
});
