const { ipcRenderer, webFrame } = require('electron');

// 1. Stealth: Hide webdriver and userAgentData
try {
  delete Object.getPrototypeOf(navigator).webdriver;
  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined,
    configurable: true
  });
} catch (e) {}

try {
  delete Object.getPrototypeOf(navigator).userAgentData;
  Object.defineProperty(navigator, 'userAgentData', {
    get: () => undefined,
    configurable: true
  });
} catch (e) {}

// 2. Clean Background Tab Audio & Video Handling (Official YouTube Player API & DOM Visibility)
let isForegroundTab = false;
try {
  const init = ipcRenderer.sendSync('get-initial-tab-state');
  if (init && typeof init.isActive === 'boolean') {
    isForegroundTab = init.isActive;
  }
} catch (e) {}

// Inject the main-world controller to override document.hidden / document.visibilityState
// and manage official YouTube #movie_player playback lifecycle
const mainWorldScript = `
(function() {
  if (window.__ytDesktopInjected) return;
  window.__ytDesktopInjected = true;

  let isForeground = ${isForegroundTab ? 'true' : 'false'};
  let hasEverBeenForeground = ${isForegroundTab ? 'true' : 'false'};
  let pendingAutoplayOnFirstSwitch = ${!isForegroundTab ? 'true' : 'false'};

  function notifyVideoStartedPlaying() {
    try {
      window.postMessage({ type: '__yt_video_started_playing__' }, '*');
    } catch (e) {}
  }

  // 1. Intercept HTMLMediaElement.prototype.play:
  // Strictly prevent unopened background tabs from playing video or advancing time before user switches to them
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function() {
    if (!isForeground && !hasEverBeenForeground) {
      pendingAutoplayOnFirstSwitch = true;
      return Promise.resolve();
    }
    return origPlay.apply(this, arguments);
  };

  // 2. Mock document.hidden & document.visibilityState in the Main World
  try {
    Object.defineProperty(document, 'hidden', {
      get: () => !isForeground,
      configurable: true
    });
    Object.defineProperty(Document.prototype, 'hidden', {
      get: () => !isForeground,
      configurable: true
    });
  } catch (e) {}

  try {
    Object.defineProperty(document, 'visibilityState', {
      get: () => isForeground ? 'visible' : 'hidden',
      configurable: true
    });
    Object.defineProperty(Document.prototype, 'visibilityState', {
      get: () => isForeground ? 'visible' : 'hidden',
      configurable: true
    });
  } catch (e) {}

  function getPlayer() {
    return document.querySelector('#movie_player');
  }

  function startPlayback() {
    const p = getPlayer();
    const v = document.querySelector('video');

    if (v && !v.paused && v.currentTime > 0) return true;
    if (p && typeof p.getPlayerState === 'function' && p.getPlayerState() === 1) return true;

    let started = false;
    if (p && typeof p.playVideo === 'function') {
      try {
        if (typeof p.getCurrentTime === 'function' && p.getCurrentTime() > 1.0 && typeof p.seekTo === 'function') {
          p.seekTo(0, true);
        }
        p.playVideo();
        started = true;
      } catch (e) {}
    } else if (v) {
      try {
        if (v.currentTime > 1.0) v.currentTime = 0;
        v.play();
        started = true;
      } catch (e) {}
    }
    return started;
  }

  function handleVisibilityChange(visible) {
    const changed = (isForeground !== visible);
    isForeground = visible;

    if (changed) {
      try {
        document.dispatchEvent(new Event('visibilitychange'));
      } catch (e) {}
    }

    if (visible) {
      if (!hasEverBeenForeground) {
        hasEverBeenForeground = true;
        if (pendingAutoplayOnFirstSwitch) {
          pendingAutoplayOnFirstSwitch = false;

          if (!startPlayback()) {
            let retries = 0;
            const retryInterval = setInterval(() => {
              retries++;
              const v = document.querySelector('video');
              const p = getPlayer();
              const isPlaying = (v && !v.paused && v.currentTime > 0) || (p && typeof p.getPlayerState === 'function' && p.getPlayerState() === 1);
              if (isPlaying || startPlayback() || retries > 30) {
                clearInterval(retryInterval);
              }
            }, 100);
          }
        }
      }
    }
    // When visible === false, we do NOT automatically pause!
    // Video continues playing in background like Google Chrome, until user plays a video on another tab.
  }

  // Cross-world event communication
  window.addEventListener('__yt_tab_visibility__', (e) => {
    if (e.detail && typeof e.detail.isVisible === 'boolean') {
      handleVisibilityChange(e.detail.isVisible);
    }
  });

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === '__yt_tab_visibility__' && typeof e.data.isVisible === 'boolean') {
      handleVisibilityChange(e.data.isVisible);
    }
  });

  window.addEventListener('yt-navigate-finish', () => {
    if (isForeground) {
      hasEverBeenForeground = true;
      pendingAutoplayOnFirstSwitch = false;
    }
  });

  // 3. Monitor YouTube #movie_player
  let observerAttached = false;
  function hookPlayer() {
    const player = getPlayer();
    if (!player) return;

    if (isForeground && !hasEverBeenForeground) {
      hasEverBeenForeground = true;
    }

    if (isForeground && pendingAutoplayOnFirstSwitch) {
      pendingAutoplayOnFirstSwitch = false;
      try {
        const state = typeof player.getPlayerState === 'function' ? player.getPlayerState() : -1;
        if (state !== 1) {
          if (typeof player.getCurrentTime === 'function' && player.getCurrentTime() > 1.0 && typeof player.seekTo === 'function') {
            player.seekTo(0, true);
          }
          if (typeof player.playVideo === 'function') player.playVideo();
        }
      } catch (e) {}
    }

    if (!observerAttached && typeof player.addEventListener === 'function') {
      observerAttached = true;
      try {
        player.addEventListener('onStateChange', (state) => {
          if (!isForeground && !hasEverBeenForeground) {
            pendingAutoplayOnFirstSwitch = true;
            try {
              if (typeof player.pauseVideo === 'function') player.pauseVideo();
              if (typeof player.seekTo === 'function') player.seekTo(0, true);
            } catch (e) {}
            return;
          }

          if (state === 1) { // 1 = playing
            notifyVideoStartedPlaying();
          }
        });
      } catch (e) {}
    }
  }

  // 4. Safety net on <video> element
  function hookVideo() {
    const video = document.querySelector('video');
    if (!video || video.__bgHooked) return;
    video.__bgHooked = true;

    if (isForeground && !hasEverBeenForeground) {
      hasEverBeenForeground = true;
    }

    video.addEventListener('playing', () => {
      if (!isForeground && !hasEverBeenForeground) {
        pendingAutoplayOnFirstSwitch = true;
        try {
          video.currentTime = 0;
          video.pause();
          const p = getPlayer();
          if (p && typeof p.pauseVideo === 'function') p.pauseVideo();
        } catch (e) {}
        return;
      }

      notifyVideoStartedPlaying();
    });

    video.addEventListener('timeupdate', () => {
      if (!isForeground && !hasEverBeenForeground && video.currentTime > 0.5) {
        pendingAutoplayOnFirstSwitch = true;
        try {
          video.currentTime = 0;
          video.pause();
          const p = getPlayer();
          if (p && typeof p.pauseVideo === 'function') {
            p.pauseVideo();
          }
        } catch (e) {}
      }
    });
  }

  const pollInterval = setInterval(() => {
    hookPlayer();
    hookVideo();
  }, 250);

  document.addEventListener('DOMContentLoaded', () => {
    hookPlayer();
    hookVideo();
  });
})();
`;

try {
  webFrame.executeJavaScript(mainWorldScript);
} catch (e) {
  window.addEventListener('DOMContentLoaded', () => {
    try {
      webFrame.executeJavaScript(mainWorldScript);
    } catch (err) {}
  });
}

window.addEventListener('message', (e) => {
  if (e.data && e.data.type === '__yt_video_started_playing__') {
    ipcRenderer.send('video-started-playing');
  }
});

ipcRenderer.on('tab-visibility-change', (event, isVisible) => {
  isForegroundTab = isVisible;
  try {
    window.dispatchEvent(new CustomEvent('__yt_tab_visibility__', {
      detail: { isVisible }
    }));
  } catch (e) {}
  try {
    window.postMessage({ type: '__yt_tab_visibility__', isVisible }, '*');
  } catch (e) {}
});

// 3. Intercept Middle-Click (scroll wheel) and Ctrl-Click to open in background tab
function getLinkHref(target) {
  if (!target) return null;
  const a = target.closest('a[href]');
  return a ? a.href : null;
}

window.addEventListener('auxclick', (e) => {
  if (e.button === 1) { // Middle click / Scroll wheel click
    const href = getLinkHref(e.target);
    if (href) {
      e.preventDefault();
      e.stopPropagation();
      ipcRenderer.send('open-url-in-new-tab', { url: href, background: true });
    }
  }
}, true);

window.addEventListener('click', (e) => {
  if (e.ctrlKey || e.metaKey) {
    const href = getLinkHref(e.target);
    if (href) {
      e.preventDefault();
      e.stopPropagation();
      ipcRenderer.send('open-url-in-new-tab', { url: href, background: true });
    }
  }
}, true);

// 4. Lightweight, safe Ad-Skipper
function setupAdSkipper() {
  const trySkip = () => {
    const skipSelectors = [
      '.ytp-skip-ad-button',
      '.ytp-ad-skip-button',
      '.ytp-ad-skip-button-modern',
      '.videoAdUiSkipButton',
      '.ytp-ad-overlay-close-button'
    ];

    for (const sel of skipSelectors) {
      const btn = document.querySelector(sel);
      if (btn && btn.offsetParent !== null) {
        btn.click();
      }
    }

    const confirmBtn = document.querySelector('yt-confirm-dialog-renderer #confirm-button');
    if (confirmBtn) confirmBtn.click();
  };

  const observer = new MutationObserver(() => {
    trySkip();
  });

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    window.addEventListener('DOMContentLoaded', () => {
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }
}

// 5. Media Controls
function controlMedia(action) {
  const video = document.querySelector('video');
  switch (action) {
    case 'play-pause':
      if (video) {
        if (video.paused) video.play();
        else video.pause();
      }
      break;
    case 'next': {
      const btn = document.querySelector('.ytp-next-button');
      if (btn) btn.click();
      break;
    }
    case 'prev': {
      const btn = document.querySelector('.ytp-prev-button');
      if (btn) btn.click();
      else window.history.back();
      break;
    }
    case 'mute': {
      const btn = document.querySelector('.ytp-mute-button');
      if (btn) btn.click();
      break;
    }
  }
}

ipcRenderer.on('media-action', (event, action) => {
  controlMedia(action);
});

// 6. X / LinkedIn-Style Channel Preview Hovercard
function setupChannelPreviewHovercard() {
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    #yt-channel-preview-card {
      position: fixed;
      z-index: 2147483647;
      width: 320px;
      background: #1e1e24;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 14px;
      box-shadow: 0 16px 36px rgba(0, 0, 0, 0.8), 0 4px 8px rgba(0, 0, 0, 0.5);
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, "Roboto", "Segoe UI", Arial, sans-serif;
      color: #fff;
      opacity: 0;
      transform: translateY(6px) scale(0.97);
      pointer-events: none;
      transition: opacity 0.16s cubic-bezier(0.2, 0, 0, 1), transform 0.16s cubic-bezier(0.2, 0, 0, 1);
    }
    #yt-channel-preview-card.visible {
      opacity: 1;
      transform: translateY(0) scale(1);
      pointer-events: auto;
    }
    .yt-preview-banner-container {
      width: 100%;
      height: 92px;
      background: linear-gradient(135deg, #1f2229 0%, #303542 50%, #1a1c22 100%);
      position: relative;
      overflow: hidden;
    }
    .yt-preview-banner {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .yt-preview-banner-fallback {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      background: linear-gradient(135deg, #1f2229 0%, #303542 50%, #1a1c22 100%);
      display: none;
    }
    .yt-preview-banner-container.no-banner .yt-preview-banner-fallback {
      display: block;
    }
    .yt-preview-banner-container.no-banner .yt-preview-banner {
      display: none;
    }
    .yt-preview-header-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      padding: 0 16px;
      margin-top: -30px;
      position: relative;
    }
    .yt-preview-avatar {
      width: 60px;
      height: 60px;
      border-radius: 50%;
      border: 3px solid #1e1e24;
      object-fit: cover;
      background: #2a2a35;
      box-shadow: 0 3px 8px rgba(0,0,0,0.5);
      flex-shrink: 0;
    }
    .yt-preview-view-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 6px 14px;
      border-radius: 18px;
      background: rgba(255, 255, 255, 0.12);
      color: #ffffff !important;
      font-size: 12px;
      font-weight: 600;
      text-decoration: none !important;
      transition: background 0.15s, color 0.15s;
      border: 1px solid rgba(255, 255, 255, 0.15);
      cursor: pointer;
    }
    .yt-preview-view-btn:hover {
      background: #ffffff;
      color: #0f0f0f !important;
    }
    .yt-preview-body {
      padding: 10px 16px 14px 16px;
    }
    .yt-preview-title {
      font-size: 15px;
      font-weight: 700;
      color: #f1f1f1;
      line-height: 1.25;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .yt-preview-handle {
      font-size: 12px;
      color: #9aa0a6;
      margin-top: 2px;
      margin-bottom: 10px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .yt-preview-stats {
      display: flex;
      align-items: center;
      gap: 16px;
      padding-bottom: 10px;
      margin-bottom: 10px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    .yt-preview-stat {
      display: flex;
      align-items: baseline;
      gap: 4px;
      font-size: 12px;
    }
    .yt-preview-stat-val {
      font-weight: 700;
      color: #ffffff;
      font-size: 13px;
    }
    .yt-preview-stat-lbl {
      color: #9aa0a6;
      font-size: 12px;
    }
    .yt-preview-desc {
      font-size: 12px;
      color: #cccccc;
      line-height: 1.4;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    @keyframes yt-skeleton-shimmer {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }
    .yt-skeleton-shimmer {
      background: linear-gradient(90deg, #252530 0%, #3a3a4c 50%, #252530 100%);
      background-size: 200% 100%;
      animation: yt-skeleton-shimmer 1.4s ease-in-out infinite;
    }

    .yt-preview-skeleton {
      display: none;
      width: 100%;
    }
    .yt-preview-content {
      display: block;
      width: 100%;
    }

    #yt-channel-preview-card.yt-preview-loading .yt-preview-skeleton {
      display: block !important;
    }
    #yt-channel-preview-card.yt-preview-loading .yt-preview-content {
      display: none !important;
    }

    .yt-skeleton-banner {
      width: 100%;
      height: 92px;
    }
    .yt-skeleton-header-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      padding: 0 16px;
      margin-top: -30px;
      position: relative;
    }
    .yt-skeleton-avatar {
      width: 60px;
      height: 60px;
      border-radius: 50%;
      border: 3px solid #1e1e24;
      flex-shrink: 0;
    }
    .yt-skeleton-btn {
      width: 88px;
      height: 28px;
      border-radius: 14px;
    }
    .yt-skeleton-body {
      padding: 12px 16px 16px 16px;
    }
    .yt-skeleton-line {
      height: 14px;
      border-radius: 4px;
      margin-bottom: 8px;
    }
    .yt-skeleton-line.title {
      width: 65%;
      height: 16px;
      margin-bottom: 6px;
    }
    .yt-skeleton-line.handle {
      width: 40%;
      height: 12px;
      margin-bottom: 14px;
    }
    .yt-skeleton-stats {
      display: flex;
      gap: 20px;
      margin-bottom: 14px;
      padding-bottom: 10px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    .yt-skeleton-stat {
      width: 60px;
      height: 14px;
      border-radius: 4px;
    }
    .yt-skeleton-line.desc1 {
      width: 95%;
      height: 11px;
      margin-bottom: 6px;
    }
    .yt-skeleton-line.desc2 {
      width: 70%;
      height: 11px;
      margin-bottom: 0;
    }

    #yt-tab-title-tooltip {
      position: fixed;
      z-index: 2147483647;
      top: 8px;
      left: 0;
      max-width: 380px;
      background: #212121;
      color: #ffffff;
      border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 8px;
      padding: 8px 14px;
      font-family: -apple-system, BlinkMacSystemFont, "Roboto", "Segoe UI", Arial, sans-serif;
      font-size: 12px;
      font-weight: 500;
      line-height: 1.4;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.75), 0 2px 6px rgba(0, 0, 0, 0.4);
      pointer-events: none;
      opacity: 0;
      transform: translateY(-4px);
      transition: opacity 0.14s ease, transform 0.14s ease, left 0.1s ease;
      word-break: break-word;
    }
    #yt-tab-title-tooltip.visible {
      opacity: 1;
      transform: translateY(0);
    }
    #yt-tab-title-tooltip::before {
      content: '';
      position: absolute;
      top: -5px;
      left: var(--arrow-left, 24px);
      width: 8px;
      height: 8px;
      background: #212121;
      border-top: 1px solid rgba(255, 255, 255, 0.16);
      border-left: 1px solid rgba(255, 255, 255, 0.16);
      transform: rotate(45deg);
    }
  `;

  const card = document.createElement('div');
  card.id = 'yt-channel-preview-card';
  card.className = 'yt-preview-loading';

  // SKELETON EMPTY STATE CONTAINER
  const skeletonContainer = document.createElement('div');
  skeletonContainer.className = 'yt-preview-skeleton';

  const skeletonBanner = document.createElement('div');
  skeletonBanner.className = 'yt-skeleton-banner yt-skeleton-shimmer';

  const skeletonHeaderRow = document.createElement('div');
  skeletonHeaderRow.className = 'yt-skeleton-header-row';

  const skeletonAvatar = document.createElement('div');
  skeletonAvatar.className = 'yt-skeleton-avatar yt-skeleton-shimmer';

  const skeletonBtn = document.createElement('div');
  skeletonBtn.className = 'yt-skeleton-btn yt-skeleton-shimmer';

  skeletonHeaderRow.appendChild(skeletonAvatar);
  skeletonHeaderRow.appendChild(skeletonBtn);

  const skeletonBody = document.createElement('div');
  skeletonBody.className = 'yt-skeleton-body';

  const skeletonTitle = document.createElement('div');
  skeletonTitle.className = 'yt-skeleton-line title yt-skeleton-shimmer';

  const skeletonHandle = document.createElement('div');
  skeletonHandle.className = 'yt-skeleton-line handle yt-skeleton-shimmer';

  const skeletonStats = document.createElement('div');
  skeletonStats.className = 'yt-skeleton-stats';

  const skeletonStat1 = document.createElement('div');
  skeletonStat1.className = 'yt-skeleton-stat yt-skeleton-shimmer';

  const skeletonStat2 = document.createElement('div');
  skeletonStat2.className = 'yt-skeleton-stat yt-skeleton-shimmer';

  skeletonStats.appendChild(skeletonStat1);
  skeletonStats.appendChild(skeletonStat2);

  const skeletonDesc1 = document.createElement('div');
  skeletonDesc1.className = 'yt-skeleton-line desc1 yt-skeleton-shimmer';

  const skeletonDesc2 = document.createElement('div');
  skeletonDesc2.className = 'yt-skeleton-line desc2 yt-skeleton-shimmer';

  skeletonBody.appendChild(skeletonTitle);
  skeletonBody.appendChild(skeletonHandle);
  skeletonBody.appendChild(skeletonStats);
  skeletonBody.appendChild(skeletonDesc1);
  skeletonBody.appendChild(skeletonDesc2);

  skeletonContainer.appendChild(skeletonBanner);
  skeletonContainer.appendChild(skeletonHeaderRow);
  skeletonContainer.appendChild(skeletonBody);

  // REAL CONTENT CONTAINER
  const contentContainer = document.createElement('div');
  contentContainer.className = 'yt-preview-content';

  const bannerContainer = document.createElement('div');
  bannerContainer.className = 'yt-preview-banner-container';
  const bannerImg = document.createElement('img');
  bannerImg.className = 'yt-preview-banner';
  bannerImg.alt = 'Banner';
  const bannerFallback = document.createElement('div');
  bannerFallback.className = 'yt-preview-banner-fallback';
  bannerContainer.appendChild(bannerImg);
  bannerContainer.appendChild(bannerFallback);

  const headerRow = document.createElement('div');
  headerRow.className = 'yt-preview-header-row';
  const avatarImg = document.createElement('img');
  avatarImg.className = 'yt-preview-avatar';
  avatarImg.alt = 'Avatar';
  const viewBtn = document.createElement('a');
  viewBtn.className = 'yt-preview-view-btn';
  viewBtn.href = '#';
  viewBtn.target = '_self';
  viewBtn.textContent = 'View Channel';
  headerRow.appendChild(avatarImg);
  headerRow.appendChild(viewBtn);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'yt-preview-body';
  const titleEl = document.createElement('div');
  titleEl.className = 'yt-preview-title';
  const handleEl = document.createElement('div');
  handleEl.className = 'yt-preview-handle';

  const statsEl = document.createElement('div');
  statsEl.className = 'yt-preview-stats';

  const stat1 = document.createElement('div');
  stat1.className = 'yt-preview-stat';
  const subsVal = document.createElement('span');
  subsVal.className = 'yt-preview-stat-val yt-preview-subs-val';
  subsVal.textContent = '--';
  const subsLbl = document.createElement('span');
  subsLbl.className = 'yt-preview-stat-lbl';
  subsLbl.textContent = 'Subscribers';
  stat1.appendChild(subsVal);
  stat1.appendChild(subsLbl);

  const stat2 = document.createElement('div');
  stat2.className = 'yt-preview-stat';
  const vidsVal = document.createElement('span');
  vidsVal.className = 'yt-preview-stat-val yt-preview-videos-val';
  vidsVal.textContent = '--';
  const vidsLbl = document.createElement('span');
  vidsLbl.className = 'yt-preview-stat-lbl';
  vidsLbl.textContent = 'Videos';
  stat2.appendChild(vidsVal);
  stat2.appendChild(vidsLbl);

  statsEl.appendChild(stat1);
  statsEl.appendChild(stat2);

  const descEl = document.createElement('div');
  descEl.className = 'yt-preview-desc';

  bodyEl.appendChild(titleEl);
  bodyEl.appendChild(handleEl);
  bodyEl.appendChild(statsEl);
  bodyEl.appendChild(descEl);

  contentContainer.appendChild(bannerContainer);
  contentContainer.appendChild(headerRow);
  contentContainer.appendChild(bodyEl);

  card.appendChild(skeletonContainer);
  card.appendChild(contentContainer);

  function ensureAttached() {
    if (!document.head.contains(styleEl)) {
      document.head.appendChild(styleEl);
    }
    const container = document.body || document.documentElement;
    if (container && !container.contains(card)) {
      container.appendChild(card);
    }
  }

  ensureAttached();

  const subsEl = subsVal;
  const videosEl = vidsVal;

  const channelCache = new Map();
  let hoverTimer = null;
  let hideTimer = null;
  let activeChannelPath = null;
  let activeAnchor = null;

  function extractChannelPath(href) {
    if (!href) return null;
    let str = '';
    if (typeof href === 'string') str = href;
    else if (href.baseVal && typeof href.baseVal === 'string') str = href.baseVal;
    else return null;

    if (str.includes('/watch') || str.includes('/shorts') || str.includes('/playlist') || str.includes('/results') || str.includes('/feed/')) {
      return null;
    }

    try {
      const url = new URL(str, location.origin);
      const pathname = url.pathname;
      const mHandle = pathname.match(/^(\/@[^\/\?#]+)/);
      if (mHandle) return mHandle[1];
      const mChannel = pathname.match(/^(\/channel\/[^\/\?#]+)/);
      if (mChannel) return mChannel[1];
      const mC = pathname.match(/^(\/c\/[^\/\?#]+)/);
      if (mC) return mC[1];
      const mUser = pathname.match(/^(\/user\/[^\/\?#]+)/);
      if (mUser) return mUser[1];
    } catch (e) {}
    return null;
  }

  function isCommentSection(el, path) {
    if (path && Array.isArray(path)) {
      for (const node of path) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) continue;
        const tag = node.tagName ? node.tagName.toUpperCase() : '';
        const id = node.id || '';
        if (
          tag === 'YTD-COMMENTS' ||
          tag === 'YTD-COMMENT-THREAD-RENDERER' ||
          tag === 'YTD-COMMENT-RENDERER' ||
          tag === 'YTD-COMMENT-VIEW-MODEL' ||
          tag === 'YTD-COMMENT-REPLIES-RENDERER' ||
          tag === 'YTD-COMMENTS-HEADER-RENDERER' ||
          (tag === 'YTD-ENGAGEMENT-PANEL-SECTION-LIST-RENDERER' && node.getAttribute('target-id') === 'engagement-panel-comments-section') ||
          id === 'comments' ||
          id === 'comment' ||
          id === 'comment-teaser' ||
          id === 'author-text' ||
          id === 'author-thumbnail' ||
          (node.classList && (
            node.classList.contains('ytd-comment-renderer') ||
            node.classList.contains('ytd-comment-view-model') ||
            node.classList.contains('comment-item') ||
            node.classList.contains('ytd-comments')
          ))
        ) {
          return true;
        }
      }
    }
    if (el && el.closest) {
      if (el.closest('ytd-comments, #comments, ytd-comment-thread-renderer, ytd-comment-renderer, ytd-comment-view-model, ytd-comment-replies-renderer, ytd-comments-header-renderer, #comment-teaser, [id="author-text"], [id="author-thumbnail"], [target-id="engagement-panel-comments-section"]')) {
        return true;
      }
    }
    return false;
  }

  function findChannelTarget(e) {
    const path = e.composedPath ? e.composedPath() : [];
    const target = e.target;

    // Never show channel preview hovercards in the comment section
    if (isCommentSection(target, path)) {
      return null;
    }

    for (const el of path) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) continue;

      // 1. Direct Anchor tag check (Channel title or avatar link)
      if (el.tagName === 'A') {
        const href = el.href || el.getAttribute('href');
        const cp = extractChannelPath(href);
        if (cp) {
          return { anchor: el, channelPath: cp };
        }
      }

      // 2. Channel name wrapper check (ytd-channel-name, #channel-name, #upload-info, #owner, #byline-container, #byline)
      if (
        el.tagName === 'YTD-CHANNEL-NAME' ||
        el.id === 'channel-name' ||
        el.id === 'upload-info' ||
        el.id === 'owner' ||
        el.id === 'byline-container' ||
        el.id === 'byline' ||
        (el.classList && (el.classList.contains('ytd-channel-name') || el.classList.contains('ytd-video-meta-block')))
      ) {
        const a = el.querySelector('a[href*="/@"], a[href*="/channel/"], a[href*="/c/"], a[href]');
        if (a) {
          const cp = extractChannelPath(a.href || a.getAttribute('href'));
          if (cp) return { anchor: a || el, channelPath: cp };
        }
        // Support recommended videos / compact renderers with Polymer navigation endpoints
        const renderer = el.closest ? el.closest('ytd-compact-video-renderer, ytd-video-meta-block, ytd-rich-grid-media, ytd-video-renderer, ytd-channel-name') : null;
        const endpointUrl = renderer?.data?.shortBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl ||
                            renderer?.data?.shortBylineText?.runs?.[0]?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url ||
                            renderer?.data?.longBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl ||
                            renderer?.data?.longBylineText?.runs?.[0]?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url ||
                            el.data?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl ||
                            el.data?.runs?.[0]?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url;
        if (endpointUrl) {
          const cp = extractChannelPath(endpointUrl);
          if (cp) return { anchor: el, channelPath: cp };
        }
      }

      // 3. Avatar containers (channel thumbnail, avatar-link, etc. outside of comments)
      if (el.id === 'avatar' || el.id === 'avatar-link' || el.id === 'channel-thumbnail') {
        const a = (el.tagName === 'A' ? el : null) || (el.closest ? el.closest('a') : null) || el.querySelector('a');
        if (a) {
          const cp = extractChannelPath(a.href || a.getAttribute('href'));
          if (cp) return { anchor: el, channelPath: cp };
        }
      }
    }

    return null;
  }

  function positionCard(anchor) {
    let target = anchor;
    let rect = target.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0 && target.parentElement) {
      rect = target.parentElement.getBoundingClientRect();
    }

    const cardWidth = 320;
    const cardHeight = card.offsetHeight || 260;

    let left = rect.left;
    if (left + cardWidth > window.innerWidth - 16) {
      left = window.innerWidth - cardWidth - 16;
    }
    if (left < 16) left = 16;

    let top = rect.bottom + 8;
    if (top + cardHeight > window.innerHeight - 16) {
      top = rect.top - cardHeight - 8;
    }
    if (top < 8) top = 8;

    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
  }

  function setCardToLoading() {
    card.classList.add('yt-preview-loading');
    bannerImg.src = '';
    avatarImg.src = '';
    titleEl.textContent = '';
    handleEl.textContent = '';
    subsEl.textContent = '--';
    videosEl.textContent = '--';
    descEl.textContent = '';
  }

  function updateCardContent(data) {
    if (data.banner) {
      bannerImg.src = data.banner;
      bannerContainer.classList.remove('no-banner');
    } else {
      bannerContainer.classList.add('no-banner');
    }

    if (data.avatar) {
      avatarImg.src = data.avatar;
    } else {
      avatarImg.src = 'https://www.youtube.com/s/desktop/f4124be3/img/favicon.ico';
    }

    titleEl.textContent = data.title;
    handleEl.textContent = data.handle;
    subsEl.textContent = data.subs;
    videosEl.textContent = data.videos;
    descEl.textContent = data.desc;

    viewBtn.href = data.url;
    viewBtn.onclick = (e) => {
      e.preventDefault();
      location.href = data.url;
    };
  }

  async function showPreviewCard(channelPath, anchor) {
    activeChannelPath = channelPath;
    activeAnchor = anchor;
    ensureAttached();
    positionCard(anchor);

    // If channel is already cached, show it directly with real data
    if (channelCache.has(channelPath)) {
      updateCardContent(channelCache.get(channelPath));
      card.classList.remove('yt-preview-loading');
      card.classList.add('visible');
      positionCard(anchor);
      return;
    }

    // Otherwise show empty skeleton animation immediately
    setCardToLoading();
    card.classList.add('visible');
    positionCard(anchor);

    const targetChannel = channelPath;
    try {
      const data = await ipcRenderer.invoke('get-channel-metadata', channelPath);
      // Guard against race conditions: only update if user is still hovering this channel!
      if (data && activeChannelPath === targetChannel) {
        channelCache.set(channelPath, data);
        updateCardContent(data);
        card.classList.remove('yt-preview-loading');
        positionCard(anchor);
      }
    } catch (err) {}
  }

  function hidePreviewCard() {
    card.classList.remove('visible');
    setCardToLoading();
    activeChannelPath = null;
    activeAnchor = null;
  }

  function isOverCardOrAnchor(related) {
    if (!related) return false;
    if (card && (card === related || card.contains(related))) return true;
    if (activeAnchor && (activeAnchor === related || activeAnchor.contains(related))) return true;
    return false;
  }

  document.addEventListener('mouseover', (e) => {
    if (card && card.contains(e.target)) {
      clearTimeout(hideTimer);
      return;
    }

    const res = findChannelTarget(e);
    if (!res) return;

    const { anchor, channelPath } = res;

    if (activeChannelPath === channelPath && card.classList.contains('visible')) {
      clearTimeout(hideTimer);
      return;
    }

    if (activeAnchor === anchor && hoverTimer) {
      clearTimeout(hideTimer);
      return;
    }

    activeAnchor = anchor;
    activeChannelPath = channelPath;
    clearTimeout(hideTimer);
    clearTimeout(hoverTimer);

    hoverTimer = setTimeout(() => {
      showPreviewCard(channelPath, anchor);
    }, 180);
  }, true);

  document.addEventListener('mouseout', (e) => {
    const related = e.relatedTarget;
    if (isOverCardOrAnchor(related)) {
      return;
    }

    clearTimeout(hoverTimer);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      hidePreviewCard();
    }, 280);
  }, true);

  window.addEventListener('scroll', () => {
    if (card.classList.contains('visible')) {
      hidePreviewCard();
    }
  }, { passive: true });

  window.addEventListener('click', (e) => {
    if (card.classList.contains('visible') && !card.contains(e.target)) {
      hidePreviewCard();
    }
  }, true);
}

// 7. Gallery / Feed Hover Video Preview Volume Cap (25%)
function setupGalleryPreviewVolume() {
  function isPreviewTarget(el) {
    if (!el) return false;
    // Don't modify the main watch page video player!
    if (el.closest && el.closest('#movie_player:not(#inline-preview-player)')) {
      return false;
    }
    return !!(el.closest && el.closest('#inline-preview-player, ytd-video-preview, ytd-inline-preview-renderer, #preview, ytd-rich-item-renderer #video-preview'));
  }

  function enforcePreviewVolume(video) {
    if (!video || !isPreviewTarget(video)) return;
    try {
      if (!video.muted && video.volume > 0.25) {
        video.volume = 0.25;
      }
    } catch (e) {}

    const player = video.closest('#inline-preview-player') || document.querySelector('#inline-preview-player');
    if (player && typeof player.setVolume === 'function') {
      try {
        if (typeof player.getVolume === 'function' && player.getVolume() > 25) {
          player.setVolume(25);
        }
      } catch (e) {}
    }
  }

  document.addEventListener('volumechange', (e) => {
    if (e.target && e.target.tagName === 'VIDEO') {
      enforcePreviewVolume(e.target);
    }
  }, true);

  document.addEventListener('play', (e) => {
    if (e.target && e.target.tagName === 'VIDEO') {
      enforcePreviewVolume(e.target);
    }
  }, true);

  document.addEventListener('playing', (e) => {
    if (e.target && e.target.tagName === 'VIDEO') {
      enforcePreviewVolume(e.target);
    }
  }, true);

  document.addEventListener('mouseover', (e) => {
    if (isPreviewTarget(e.target)) {
      const v = e.target.tagName === 'VIDEO' ? e.target : (e.target.querySelector ? e.target.querySelector('video') : null);
      if (v) enforcePreviewVolume(v);
    }
  }, true);
}

// 8. Tab Title Tooltip Dialog Box (like YouTube gallery card title tooltip)
function setupTabTitleTooltip() {
  const tooltip = document.createElement('div');
  tooltip.id = 'yt-tab-title-tooltip';

  function ensureTooltipAttached() {
    const container = document.body || document.documentElement;
    if (container && !container.contains(tooltip)) {
      container.appendChild(tooltip);
    }
  }

  ipcRenderer.on('show-tab-tooltip', (event, { title, x }) => {
    let display = title;
    if ((!display || display === 'Loading...') && document.title && document.title !== 'Loading...') {
      display = document.title;
    }
    if (!display || display === 'Loading...') return;
    ensureTooltipAttached();

    const width = tooltip.offsetWidth || 240;
    let left = x - width / 2;
    if (left < 16) left = 16;
    if (left + width > window.innerWidth - 16) {
      left = window.innerWidth - width - 16;
    }
    const arrowX = Math.round(Math.max(14, Math.min(width - 14, x - left)));

    if (tooltip.textContent === display && tooltip.classList.contains('visible')) {
      tooltip.style.left = `${Math.round(left)}px`;
      tooltip.style.setProperty('--arrow-left', `${arrowX}px`);
      return;
    }

    tooltip.textContent = display;
    tooltip.classList.add('visible');
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.setProperty('--arrow-left', `${arrowX}px`);
  });

  ipcRenderer.on('hide-tab-tooltip', () => {
    tooltip.classList.remove('visible');
  });
}

// Fullscreen Top-Center Chrome-Style "✕" Exit Button
function setupFullScreenExitButton() {
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    #yt-fs-exit-btn {
      all: initial !important;
      position: fixed !important;
      top: 14px !important;
      left: 50% !important;
      transform: translate(-50%, -60px) scale(0.9) !important;
      width: 40px !important;
      height: 40px !important;
      min-width: 40px !important;
      min-height: 40px !important;
      max-width: 40px !important;
      max-height: 40px !important;
      border-radius: 50% !important;
      background: rgba(24, 24, 28, 0.92) !important;
      backdrop-filter: blur(12px) !important;
      -webkit-backdrop-filter: blur(12px) !important;
      border: 1px solid rgba(255, 255, 255, 0.25) !important;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.75), 0 1px 4px rgba(0, 0, 0, 0.5) !important;
      color: #ffffff !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      cursor: pointer !important;
      z-index: 2147483647 !important;
      opacity: 0 !important;
      pointer-events: none !important;
      transition: transform 0.22s cubic-bezier(0.1, 0.9, 0.2, 1),
                  opacity 0.2s ease,
                  background 0.15s ease,
                  border-color 0.15s ease,
                  box-shadow 0.15s ease !important;
      user-select: none !important;
      outline: none !important;
      box-sizing: border-box !important;
      padding: 0 !important;
      margin: 0 !important;
      line-height: 1 !important;
    }
    #yt-fs-exit-btn.visible {
      transform: translate(-50%, 0) scale(1) !important;
      opacity: 1 !important;
      pointer-events: auto !important;
      visibility: visible !important;
      cursor: pointer !important;
    }
    #yt-fs-exit-btn:hover {
      background: rgba(48, 48, 58, 0.98) !important;
      border-color: rgba(255, 255, 255, 0.45) !important;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.85), 0 0 12px rgba(255, 255, 255, 0.25) !important;
      transform: translate(-50%, 0) scale(1.08) !important;
    }
    #yt-fs-exit-btn:active {
      transform: translate(-50%, 0) scale(0.95) !important;
      background: rgba(65, 65, 78, 1) !important;
    }
    #yt-fs-exit-btn svg {
      width: 14px !important;
      height: 14px !important;
      min-width: 14px !important;
      min-height: 14px !important;
      max-width: 14px !important;
      max-height: 14px !important;
      stroke: #ffffff !important;
      stroke-width: 2.2 !important;
      stroke-linecap: round !important;
      stroke-linejoin: round !important;
      display: block !important;
      pointer-events: none !important;
      fill: none !important;
      box-sizing: content-box !important;
    }
  `;
  (document.head || document.documentElement).appendChild(styleEl);

  const btn = document.createElement('button');
  btn.id = 'yt-fs-exit-btn';
  btn.title = 'Exit full screen (Esc)';
  btn.setAttribute('aria-label', 'Exit full screen');
  btn.innerHTML = `
    <svg viewBox="0 0 14 14" fill="none">
      <line x1="2.5" y1="2.5" x2="11.5" y2="11.5"/>
      <line x1="11.5" y1="2.5" x2="2.5" y2="11.5"/>
    </svg>
  `;

  let isFullScreen = false;
  let hideTimer = null;
  let isHoveringBtn = false;

  function checkIsFullScreen() {
    if (isFullScreen) return true;
    if (document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement) {
      return true;
    }
    const player = document.querySelector('#movie_player');
    if (player) {
      if (player.classList.contains('ytp-fullscreen')) return true;
      if (typeof player.isFullScreen === 'function') {
        try { if (player.isFullScreen()) return true; } catch (e) {}
      }
    }
    const watchFlexy = document.querySelector('ytd-watch-flexy');
    if (watchFlexy && watchFlexy.hasAttribute('fullscreen')) return true;
    if (document.documentElement.classList.contains('ytp-fullscreen')) return true;
    if (document.body.classList.contains('ytp-fullscreen')) return true;
    return false;
  }

  function getTargetContainer() {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) return fsEl;
    const player = document.querySelector('#movie_player');
    if (player && (player.classList.contains('ytp-fullscreen') || isFullScreen)) {
      return player;
    }
    return document.body || document.documentElement;
  }

  function ensureAttached() {
    const container = getTargetContainer();
    if (container && btn.parentElement !== container) {
      container.appendChild(btn);
    }
  }

  function showButton() {
    clearTimeout(hideTimer);
    hideTimer = null;
    ensureAttached();
    btn.classList.add('visible');
  }

  function hideButton(immediate = false) {
    if (immediate) {
      clearTimeout(hideTimer);
      hideTimer = null;
      btn.classList.remove('visible');
      return;
    }
    if (isHoveringBtn) return;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!isHoveringBtn) {
        btn.classList.remove('visible');
      }
    }, 750);
  }

  function updateFullScreenState(fs) {
    const previous = isFullScreen;
    isFullScreen = (typeof fs === 'boolean') ? fs : checkIsFullScreen();
    if (!isFullScreen) {
      hideButton(true);
      if (btn.parentElement && btn.parentElement !== document.body) {
        (document.body || document.documentElement).appendChild(btn);
      }
    } else {
      ensureAttached();
    }
  }

  function doExitFullScreen(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    hideButton(true);

    // 1. YouTube native player exit
    const player = document.querySelector('#movie_player');
    if (player) {
      if (typeof player.cancelFullScreen === 'function') {
        try { player.cancelFullScreen(); } catch (err) {}
      }
      if (typeof player.toggleFullscreen === 'function' && player.classList.contains('ytp-fullscreen')) {
        try { player.toggleFullscreen(); } catch (err) {}
      }
    }

    // 2. DOM Fullscreen API
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      }
    }

    // 3. Electron IPC to restore window bounds
    try {
      ipcRenderer.send('exit-fullscreen');
    } catch (err) {}
  }

  btn.addEventListener('click', doExitFullScreen);
  btn.addEventListener('pointerenter', () => {
    isHoveringBtn = true;
    showButton();
  });
  btn.addEventListener('pointerleave', () => {
    isHoveringBtn = false;
    hideButton();
  });

  function handlePointerMove(e) {
    const fsNow = checkIsFullScreen();
    if (!fsNow) {
      if (btn.classList.contains('visible')) hideButton(true);
      return;
    }
    isFullScreen = true;

    const clientY = e.clientY;
    const clientX = e.clientX;
    const centerX = window.innerWidth / 2;
    const distFromCenter = Math.abs(clientX - centerX);

    // Natural Chrome-parity Hit Zone:
    // 1. Within top 45px across entire screen, OR
    // 2. Within top 85px within 350px of horizontal center
    const isNearTopCenter = (clientY <= 45) || (clientY <= 85 && distFromCenter <= 350);

    if (isNearTopCenter) {
      showButton();
    } else if (!isHoveringBtn) {
      if (btn.classList.contains('visible')) {
        hideButton();
      }
    }
  }

  window.addEventListener('mousemove', handlePointerMove, { capture: true, passive: true });
  window.addEventListener('pointermove', handlePointerMove, { capture: true, passive: true });

  document.addEventListener('fullscreenchange', () => updateFullScreenState());
  document.addEventListener('webkitfullscreenchange', () => updateFullScreenState());
  window.addEventListener('fullscreenchange', () => updateFullScreenState());
  window.addEventListener('webkitfullscreenchange', () => updateFullScreenState());

  // Observe YouTube's movie_player class changes for instant fullscreen toggle detection
  function observePlayer() {
    const player = document.querySelector('#movie_player');
    if (player && !player._fsObserverAttached) {
      player._fsObserverAttached = true;
      const observer = new MutationObserver(() => {
        updateFullScreenState(player.classList.contains('ytp-fullscreen'));
      });
      observer.observe(player, { attributes: true, attributeFilter: ['class'] });
    }
  }

  observePlayer();
  const playerPoller = setInterval(() => {
    observePlayer();
    if (document.querySelector('#movie_player')?._fsObserverAttached) {
      clearInterval(playerPoller);
    }
  }, 1000);

  ipcRenderer.on('fullscreen-state-change', (event, fs) => {
    updateFullScreenState(fs);
  });

  updateFullScreenState();
}

// Run as soon as DOM is interactive or on load
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', () => {
    setupAdSkipper();
    setupChannelPreviewHovercard();
    setupGalleryPreviewVolume();
    setupTabTitleTooltip();
    setupFullScreenExitButton();
  });
} else {
  setupAdSkipper();
  setupChannelPreviewHovercard();
  setupGalleryPreviewVolume();
  setupTabTitleTooltip();
  setupFullScreenExitButton();
}

// Seamless Drag & Drop: notify main window when user begins dragging text or links
['dragstart'].forEach(ev => {
  window.addEventListener(ev, () => {
    try { ipcRenderer.send('page-text-drag-start'); } catch (err) {}
  }, true);
  document.addEventListener(ev, () => {
    try { ipcRenderer.send('page-text-drag-start'); } catch (err) {}
  }, true);
});

['dragend'].forEach(ev => {
  window.addEventListener(ev, () => {
    try { ipcRenderer.send('page-text-drag-end'); } catch (err) {}
  }, true);
  document.addEventListener(ev, () => {
    try { ipcRenderer.send('page-text-drag-end'); } catch (err) {}
  }, true);
});
