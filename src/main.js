const { app, BrowserWindow, WebContentsView, Menu, Tray, MenuItem, globalShortcut, ipcMain, shell, screen, session } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');

app.name = 'YouTube';
const userDataPath = path.join(app.getPath('appData'), 'YouTube');
try {
  app.setPath('userData', userDataPath);
} catch (e) {}

const logFile = path.join(app.getPath('userData'), 'app-debug.log');
function log(msg) {
  try {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (e) {}
}

log('Starting YouTube Desktop...');

process.on('uncaughtException', (err) => {
  log('UNCAUGHT EXCEPTION: ' + err.stack);
});

process.on('unhandledRejection', (reason) => {
  log('UNHANDLED REJECTION: ' + (reason ? (reason.stack || reason) : 'unknown'));
});

// 1. Single Instance Lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  log('Could not get single instance lock, quitting');
  app.quit();
  process.exit(0);
}
log('Single instance lock acquired');

// 2. Performance & Hardware Acceleration Flags (Chrome-Equivalent Speed)
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('autoplay-policy', 'user-gesture-required');

let mainWindow = null;
let isQuitting = false;
let isMiniPlayer = false;
let isAlwaysOnTop = false;
let isHtmlFullScreen = false;
let normalBounds = null;
let wasMaximized = false;

let tabs = [];
let activeTabId = null;

const SHELL_HEIGHT = 40; // 40px tabbar (no browser URL toolbar)
const DEFAULT_HOME_URL = 'https://www.youtube.com/';

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

app.userAgentFallback = CHROME_UA;

const stateFilePath = path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  try {
    if (fs.existsSync(stateFilePath)) {
      return JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
    }
  } catch (e) {}
  return { width: 1280, height: 820, isMaximized: false };
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) return; // Never save corrupted bounds while minimized
  try {
    const isMax = mainWindow.isMaximized();
    const bounds = isMax ? (normalBounds || mainWindow.getBounds()) : mainWindow.getBounds();

    const savedTabs = tabs.map(t => {
      let currentUrl = t.url;
      try {
        if (t.view && !t.view.webContents.isDestroyed()) {
          const liveUrl = t.view.webContents.getURL();
          if (liveUrl && liveUrl !== 'about:blank') {
            currentUrl = liveUrl;
          }
        }
      } catch (e) {}
      return {
        url: currentUrl,
        title: t.title
      };
    }).filter(t => t.url && t.url !== 'about:blank');

    const activeIdx = Math.max(0, tabs.findIndex(t => t.id === activeTabId));

    const data = {
      ...bounds,
      isMaximized: isMax,
      alwaysOnTop: isAlwaysOnTop,
      tabs: savedTabs,
      activeTabIndex: activeIdx
    };
    fs.writeFileSync(stateFilePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {}
}

function isAuthUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    const isGoogle = /(^|\.)(google|googleapis|gstatic|googleusercontent)\./i.test(host);
    const isAccountsYT = host.includes('accounts.youtube.');
    return (
      isGoogle ||
      isAccountsYT ||
      parsed.pathname.includes('/signin') ||
      parsed.pathname.includes('/ServiceLogin') ||
      parsed.pathname.includes('/CheckCookie')
    );
  } catch (e) {
    return false;
  }
}

function isInternalDomain(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    return /(^|\.)(youtube|google|youtu|gstatic|googleapis|googleusercontent|gvt1)\./i.test(host);
  } catch (e) {
    return false;
  }
}

function checkCanGoBack(wc) {
  if (!wc || wc.isDestroyed()) return false;
  try {
    if (wc.navigationHistory && typeof wc.navigationHistory.canGoBack === 'function') {
      return wc.navigationHistory.canGoBack();
    }
    return typeof wc.canGoBack === 'function' ? wc.canGoBack() : false;
  } catch (e) {
    return false;
  }
}

function checkCanGoForward(wc) {
  if (!wc || wc.isDestroyed()) return false;
  try {
    if (wc.navigationHistory && typeof wc.navigationHistory.canGoForward === 'function') {
      return wc.navigationHistory.canGoForward();
    }
    return typeof wc.canGoForward === 'function' ? wc.canGoForward() : false;
  } catch (e) {
    return false;
  }
}

const knownTitles = new Map(); // url -> string

function formatHistoryTitle(url) {
  if (!url) return 'YouTube';
  try {
    const parsed = new URL(url);
    const p = parsed.pathname;
    if (p === '/' || p === '') return 'YouTube Home';
    if (p.startsWith('/feed/subscriptions')) return 'Subscriptions';
    if (p.startsWith('/feed/history')) return 'History';
    if (p.startsWith('/feed/you') || p.startsWith('/feed/library')) return 'You / Library';
    if (p.startsWith('/feed/trending')) return 'Trending';
    if (p.startsWith('/playlist')) return 'Playlist';
    if (p.startsWith('/results')) {
      const q = parsed.searchParams.get('search_query');
      return q ? `"${q}"` : 'Search Results';
    }
    if (p.startsWith('/watch')) {
      return 'YouTube Video';
    }
    if (p.startsWith('/@')) {
      return parsed.pathname.slice(1);
    }
    return 'YouTube';
  } catch (e) {
    return 'YouTube';
  }
}

function truncateTitle(str, maxLen = 42) {
  if (!str) return 'YouTube';
  let clean = str.replace(/ - YouTube$/i, '').trim();
  if (clean.length > maxLen) {
    clean = clean.substring(0, maxLen - 1) + '…';
  }
  return clean || 'YouTube';
}

function broadcastState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const serializedTabs = tabs.map(t => {
    let canBack = t.canGoBack;
    let canForward = t.canGoForward;
    try {
      if (t.view && !t.view.webContents.isDestroyed()) {
        canBack = checkCanGoBack(t.view.webContents);
        canForward = checkCanGoForward(t.view.webContents);
        t.canGoBack = canBack;
        t.canGoForward = canForward;
      }
    } catch (e) {}

    return {
      id: t.id,
      url: t.url,
      title: t.title,
      favicon: t.favicon,
      isLoading: !!t.isLoading,
      isAudible: t.isAudible,
      canGoBack: !!canBack,
      canGoForward: !!canForward
    };
  });

  mainWindow.webContents.send('sync-state', {
    tabs: serializedTabs,
    activeTabId: activeTabId,
    alwaysOnTop: isAlwaysOnTop,
    isMiniPlayer: isMiniPlayer,
    isMaximized: mainWindow.isMaximized() || mainWindow.isFullScreen()
  });
}

function pauseOtherTabs(playingTabId) {
  log('pauseOtherTabs called for playingTab: ' + playingTabId);
  tabs.forEach(t => {
    if (t.id !== playingTabId && t.view && !t.view.webContents.isDestroyed()) {
      try {
        t.view.webContents.executeJavaScript(`
          (function() {
            try {
              const p = document.querySelector('#movie_player');
              const v = document.querySelector('video');
              if (p && typeof p.pauseVideo === 'function') {
                p.pauseVideo();
              } else if (v) {
                v.pause();
              }
            } catch (e) {}
          })();
        `).catch(() => {});
      } catch (e) {}
    }
  });
}

function updateActiveViewBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) return; // Prevent collapse to 0x0 while minimized on Windows
  const [width, height] = mainWindow.getContentSize();
  if (width <= 0 || height <= 0) return;

  const contentHeight = Math.max(0, height - SHELL_HEIGHT);

  tabs.forEach(t => {
    if (!t.view || t.view.webContents.isDestroyed()) return;

    if (t.id === activeTabId) {
      if (isHtmlFullScreen) {
        t.view.setBounds({ x: 0, y: 0, width: width, height: height });
      } else {
        t.view.setBounds({ x: 0, y: SHELL_HEIGHT, width: width, height: contentHeight });
      }
      t.view.setVisible(true);
      try { t.view.webContents.setAudioMuted(false); } catch (e) {}
      t.view.webContents.send('tab-visibility-change', true);
    } else {
      // Inactive tabs retain real layout bounds so video/DOM doesn't freeze or reflow
      t.view.setBounds({ x: 0, y: SHELL_HEIGHT, width: width, height: contentHeight });
      t.view.setVisible(false);
      try { t.view.webContents.setAudioMuted(false); } catch (e) {}
      t.view.webContents.send('tab-visibility-change', false);
    }
  });
}

function switchTab(tabId) {
  const targetTab = tabs.find(t => t.id === tabId);
  if (!targetTab) return;

  activeTabId = tabId;
  targetTab.hasEverBeenForeground = true;
  updateActiveViewBounds();
  try {
    targetTab.view.webContents.focus();
  } catch (e) {}
  broadcastState();
}

const NO_GLITCH_CSS = `
  html, body {
    background-color: #0f0f0f !important;
    color: #f1f1f1 !important;
  }
  #splash, #splash-icon, #masthead-skeleton, ytd-masthead-skeleton {
    display: none !important;
    visibility: hidden !important;
    opacity: 0 !important;
    pointer-events: none !important;
  }
  ytd-masthead #logo, ytd-topbar-logo-renderer#logo {
    display: none !important;
  }
`;

function createTab(url = DEFAULT_HOME_URL, isBackground = false, insertIndex = -1) {
  log('createTab called with url: ' + url + ' isBackground: ' + isBackground + ' insertIndex: ' + insertIndex);
  const tabId = 'tab_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);

  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      plugins: true,
      webSecurity: true,
      hardwareAcceleration: true,
      backgroundThrottling: false // Full speed loading in background
    }
  });

  view.webContents.setBackgroundThrottling(false);
  view.setBackgroundColor('#0f0f0f');
  try { view.webContents.setAudioMuted(false); } catch (e) {}

  // Prevent splash screen glitching & white flashes
  view.webContents.on('did-start-loading', () => {
    view.webContents.insertCSS(NO_GLITCH_CSS).catch(() => {});
    tab.isLoading = true;
    broadcastState();
  });
  view.webContents.on('did-stop-loading', () => {
    tab.isLoading = false;
    broadcastState();
  });
  view.webContents.on('dom-ready', () => {
    view.webContents.insertCSS(NO_GLITCH_CSS).catch(() => {});
    const isActive = (tab.id === activeTabId);
    view.webContents.send('tab-visibility-change', isActive);
  });

  const tab = {
    id: tabId,
    url: url,
    title: 'Loading...',
    favicon: 'https://www.youtube.com/s/desktop/f4124be3/img/favicon.ico',
    view: view,
    isLoading: true,
    isAudible: false,
    canGoBack: false,
    canGoForward: false,
    hasEverBeenForeground: !isBackground
  };

  view.webContents.on('media-started-playing', () => {
    pauseOtherTabs(tab.id);
  });

  // Chrome Keyboard Shortcuts inside tab view (Ctrl+T, Ctrl+W, Ctrl+Tab, Ctrl+1..9)
  view.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;

    const isCtrl = input.control || input.meta;
    const key = input.key.toLowerCase();

    // Ctrl+T: New Tab
    if (isCtrl && !input.shift && !input.alt && key === 't') {
      event.preventDefault();
      createTab(DEFAULT_HOME_URL, false);
      saveWindowState();
      return;
    }

    // Ctrl+W: Close Tab
    if (isCtrl && !input.shift && !input.alt && key === 'w') {
      event.preventDefault();
      closeTab(tab.id);
      return;
    }

    // Ctrl+Tab / Ctrl+Shift+Tab: Switch Tab
    if (isCtrl && !input.alt && input.key === 'Tab') {
      event.preventDefault();
      const currentIdx = tabs.findIndex(t => t.id === activeTabId);
      if (currentIdx !== -1 && tabs.length > 1) {
        const nextIdx = input.shift
          ? (currentIdx - 1 + tabs.length) % tabs.length
          : (currentIdx + 1) % tabs.length;
        switchTab(tabs[nextIdx].id);
      }
      return;
    }

    // Ctrl+1 through Ctrl+8: Switch to tab 1..8
    if (isCtrl && !input.shift && !input.alt && input.key >= '1' && input.key <= '8') {
      const targetIdx = parseInt(input.key, 10) - 1;
      if (targetIdx < tabs.length) {
        event.preventDefault();
        switchTab(tabs[targetIdx].id);
      }
      return;
    }

    // Ctrl+9: Switch to last tab
    if (isCtrl && !input.shift && !input.alt && input.key === '9') {
      if (tabs.length > 0) {
        event.preventDefault();
        switchTab(tabs[tabs.length - 1].id);
      }
      return;
    }

    // Ctrl+R or F5: Reload active tab
    if ((isCtrl && !input.shift && !input.alt && key === 'r') || input.key === 'F5') {
      event.preventDefault();
      view.webContents.reload();
      return;
    }

    // Alt+Left Arrow: Back
    if (input.alt && !input.control && !input.shift && input.key === 'ArrowLeft') {
      event.preventDefault();
      if (checkCanGoBack(view.webContents)) {
        if (view.webContents.navigationHistory) view.webContents.navigationHistory.goBack();
        else view.webContents.goBack();
        setTimeout(broadcastState, 50);
      }
      return;
    }

    // Alt+Right Arrow: Forward
    if (input.alt && !input.control && !input.shift && input.key === 'ArrowRight') {
      event.preventDefault();
      if (checkCanGoForward(view.webContents)) {
        if (view.webContents.navigationHistory) view.webContents.navigationHistory.goForward();
        else view.webContents.goForward();
        setTimeout(broadcastState, 50);
      }
      return;
    }
  });

  // Mouse Back / Forward Button support
  view.webContents.on('app-command', (event, cmd) => {
    if (cmd === 'browser-backward') {
      event.preventDefault();
      if (checkCanGoBack(view.webContents)) {
        if (view.webContents.navigationHistory) view.webContents.navigationHistory.goBack();
        else view.webContents.goBack();
        setTimeout(broadcastState, 50);
      }
    } else if (cmd === 'browser-forward') {
      event.preventDefault();
      if (checkCanGoForward(view.webContents)) {
        if (view.webContents.navigationHistory) view.webContents.navigationHistory.goForward();
        else view.webContents.goForward();
        setTimeout(broadcastState, 50);
      }
    }
  });

  view.webContents.on('will-prevent-unload', (e) => {
    e.preventDefault();
  });

  // HTML5 Fullscreen for video
  view.webContents.on('enter-html-full-screen', () => {
    isHtmlFullScreen = true;
    mainWindow.setFullScreen(true);
    const [w, h] = mainWindow.getSize();
    view.setBounds({ x: 0, y: 0, width: w, height: h });
  });

  view.webContents.on('leave-html-full-screen', () => {
    isHtmlFullScreen = false;
    mainWindow.setFullScreen(false);
    updateActiveViewBounds();
  });

  view.webContents.on('will-navigate', (event, navUrl) => {
    view.webContents.setUserAgent(CHROME_UA);
    if (!isInternalDomain(navUrl)) {
      event.preventDefault();
      shell.openExternal(navUrl);
    }
  });

  view.webContents.on('did-start-navigation', (event, navUrl, isInPlace, isMainFrame) => {
    if (isMainFrame) {
      view.webContents.setUserAgent(CHROME_UA);
    }
  });



  view.webContents.on('page-title-updated', (event, title) => {
    tab.title = title || 'YouTube';
    if (title && title.trim() && title !== 'YouTube' && title !== 'Loading...') {
      if (tab.url) knownTitles.set(tab.url, title);
      try {
        const curUrl = view.webContents.getURL();
        if (curUrl && curUrl !== 'about:blank') knownTitles.set(curUrl, title);
      } catch (e) {}
    }
    broadcastState();
  });

  view.webContents.on('page-favicon-updated', (event, favicons) => {
    if (favicons && favicons.length > 0) {
      tab.favicon = favicons[0];
      broadcastState();
    }
  });

  view.webContents.on('did-navigate', (event, navUrl) => {
    tab.url = navUrl;
    tab.canGoBack = checkCanGoBack(view.webContents);
    tab.canGoForward = checkCanGoForward(view.webContents);
    try {
      const curTitle = view.webContents.getTitle();
      if (curTitle && curTitle.trim() && curTitle !== 'YouTube' && curTitle !== 'Loading...') {
        knownTitles.set(navUrl, curTitle);
      }
    } catch (e) {}
    broadcastState();
    saveWindowState();
  });

  view.webContents.on('did-navigate-in-page', (event, navUrl) => {
    tab.url = navUrl;
    tab.canGoBack = checkCanGoBack(view.webContents);
    tab.canGoForward = checkCanGoForward(view.webContents);
    try {
      const curTitle = view.webContents.getTitle();
      if (curTitle && curTitle.trim() && curTitle !== 'YouTube' && curTitle !== 'Loading...') {
        knownTitles.set(navUrl, curTitle);
      }
    } catch (e) {}
    broadcastState();
    saveWindowState();
  });

  view.webContents.on('media-started-playing', () => {
    tab.isAudible = true;
    broadcastState();
  });

  view.webContents.on('media-paused', () => {
    tab.isAudible = false;
    broadcastState();
  });

  view.webContents.setWindowOpenHandler(({ url: openUrl }) => {
    if (isInternalDomain(openUrl)) {
      createTab(openUrl, true);
      return { action: 'deny' };
    }
    shell.openExternal(openUrl);
    return { action: 'deny' };
  });

  // Native context menu on video page (NEVER cropped!)
  view.webContents.on('context-menu', (event, params) => {
    const menuTemplate = [];

    // Chrome Parity: Right-click selected text to search YouTube in a new tab
    if (params.selectionText && params.selectionText.trim()) {
      const q = params.selectionText.trim();
      menuTemplate.push({
        label: `Search YouTube for "${truncateTitle(q, 24)}"`,
        click: () => {
          const searchUrl = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q);
          createTab(searchUrl, false);
          saveWindowState();
        }
      });
      menuTemplate.push({ role: 'copy' });
      menuTemplate.push({ type: 'separator' });
    }

    if (params.linkURL) {
      menuTemplate.push({
        label: 'Open Video in New Tab',
        click: () => createTab(params.linkURL, true)
      });
      menuTemplate.push({
        label: 'Copy Link Address',
        role: 'copyLink'
      });
      menuTemplate.push({ type: 'separator' });
    }

    menuTemplate.push(
      { label: 'Back', enabled: checkCanGoBack(view.webContents), click: () => view.webContents.navigationHistory.goBack() },
      { label: 'Forward', enabled: checkCanGoForward(view.webContents), click: () => view.webContents.navigationHistory.goForward() },
      { label: 'Reload', click: () => view.webContents.reload() }
    );

    const menu = Menu.buildFromTemplate(menuTemplate);
    menu.popup();
  });

  tab.isBackground = isBackground;
  if (typeof insertIndex === 'number' && insertIndex >= 0 && insertIndex <= tabs.length) {
    tabs.splice(insertIndex, 0, tab);
  } else {
    tabs.push(tab);
  }
  if (!isBackground) {
    activeTabId = tabId;
  }

  // Attach view to window content view
  try {
    mainWindow.contentView.addChildView(view);
  } catch (e) {}

  view.webContents.loadURL(url, { userAgent: CHROME_UA });

  const [w, h] = mainWindow.getContentSize();
  view.setBounds({ x: 0, y: SHELL_HEIGHT, width: w, height: Math.max(0, h - SHELL_HEIGHT) });

  if (isBackground) {
    view.setVisible(false);
    view.webContents.send('tab-visibility-change', false);
    broadcastState();
  } else {
    switchTab(tabId);
  }

  return tab;
}

function closeTab(tabId) {
  const index = tabs.findIndex(t => t.id === tabId);
  if (index === -1) return;

  const targetTab = tabs[index];

  // IMMEDIATELY KILL AUDIO & VIDEO
  try {
    targetTab.view.webContents.stop();
    targetTab.view.webContents.loadURL('about:blank');
    targetTab.view.webContents.destroy();
  } catch (e) {}

  try {
    mainWindow.contentView.removeChildView(targetTab.view);
  } catch (e) {}

  tabs.splice(index, 1);

  if (tabs.length === 0) {
    createTab(DEFAULT_HOME_URL, false);
  } else if (activeTabId === tabId) {
    const nextIndex = Math.min(index, tabs.length - 1);
    switchTab(tabs[nextIndex].id);
  } else {
    broadcastState();
  }

  saveWindowState();
}

function createWindow() {
  log('createWindow entered');
  const state = loadWindowState();
  log('Loaded state: ' + JSON.stringify(state));
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.ico');

  // Ensure request headers always send clean Chrome headers
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders['User-Agent'] = CHROME_UA;
    callback({ cancel: false, requestHeaders: details.requestHeaders });
  });

  let initialBounds = { width: state.width || 1280, height: state.height || 820 };
  if (state.x !== undefined && state.y !== undefined) {
    initialBounds.x = state.x;
    initialBounds.y = state.y;
  }

  mainWindow = new BrowserWindow({
    ...initialBounds,
    minWidth: 420,
    minHeight: 260,
    title: 'YouTube',
    icon: iconPath,
    backgroundColor: '#0f0f0f',
    show: false, // Prevents white flash on launch
    frame: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  log('mainWindow instantiated');

  if (state.alwaysOnTop) {
    isAlwaysOnTop = true;
    mainWindow.setAlwaysOnTop(true, 'normal');
  }

  if (state.isMaximized) {
    mainWindow.maximize();
  }

  mainWindow.loadFile(path.join(__dirname, 'ui', 'shell.html'));
  log('mainWindow.loadFile called');

  mainWindow.once('ready-to-show', () => {
    log('mainWindow ready-to-show');
    mainWindow.show();
  });

  // RESTORE TABS FROM PREVIOUS SESSION OR LOAD DEFAULT SUBSCRIPTIONS
  mainWindow.webContents.on('did-finish-load', () => {
    log('mainWindow webContents did-finish-load');
    if (state.tabs && state.tabs.length > 0) {
      state.tabs.forEach((savedTab) => {
        createTab(savedTab.url, true);
      });
      const targetIdx = (state.activeTabIndex !== undefined && state.activeTabIndex < tabs.length)
        ? state.activeTabIndex
        : 0;
      if (tabs[targetIdx]) {
        switchTab(tabs[targetIdx].id);
      }
    } else {
      createTab(DEFAULT_HOME_URL, false);
    }
  });

  let resizeTimer = null;
  const onBoundsChange = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) return; // Never resize views or overwrite normalBounds when minimized!
    updateActiveViewBounds();
    if (!isMiniPlayer && !mainWindow.isMaximized()) {
      normalBounds = mainWindow.getBounds();
    }
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(saveWindowState, 500);
  };

  const handleRestoreOrMaximize = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) return;
    updateActiveViewBounds();
    broadcastState();
    // Flush paint and layout buffers after Windows DWM transition finishes
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
      updateActiveViewBounds();
      broadcastState();
      try {
        mainWindow.webContents.invalidate();
        const activeTab = tabs.find(t => t.id === activeTabId);
        if (activeTab && activeTab.view && !activeTab.view.webContents.isDestroyed()) {
          activeTab.view.webContents.invalidate();
        }
      } catch (e) {}
    }, 60);
  };

  mainWindow.on('resize', onBoundsChange);
  mainWindow.on('move', onBoundsChange);
  mainWindow.on('maximize', handleRestoreOrMaximize);
  mainWindow.on('unmaximize', handleRestoreOrMaximize);
  mainWindow.on('restore', handleRestoreOrMaximize);
  mainWindow.on('show', handleRestoreOrMaximize);
  mainWindow.on('focus', () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    updateActiveViewBounds();
  });

  mainWindow.on('enter-full-screen', () => {
    updateActiveViewBounds();
  });
  mainWindow.on('leave-full-screen', () => {
    updateActiveViewBounds();
  });

  // CLOSE WINDOW: Saves tabs, terminates all video/audio, and quits app like Chrome
  mainWindow.on('close', (e) => {
    log('mainWindow close event triggered');
    isQuitting = true;
    saveWindowState();

    tabs.forEach(t => {
      try {
        if (t.view && !t.view.webContents.isDestroyed()) {
          t.view.webContents.stop();
          t.view.webContents.destroy();
        }
      } catch (e) {}
    });

    app.exit(0);
  });

  registerShortcuts();
}

function toggleMiniPlayer() {
  if (!mainWindow) return;

  isMiniPlayer = !isMiniPlayer;

  if (isMiniPlayer) {
    wasMaximized = mainWindow.isMaximized();
    normalBounds = mainWindow.getBounds();

    if (wasMaximized) mainWindow.unmaximize();

    const primaryDisplay = screen.getPrimaryDisplay();
    const workArea = primaryDisplay.workArea;
    const miniWidth = 460;
    const miniHeight = 260;
    const margin = 24;

    mainWindow.setBounds({
      x: workArea.x + workArea.width - miniWidth - margin,
      y: workArea.y + workArea.height - miniHeight - margin,
      width: miniWidth,
      height: miniHeight
    });

    mainWindow.setAlwaysOnTop(true, 'screen-saver');
  } else {
    mainWindow.setAlwaysOnTop(isAlwaysOnTop, 'normal');
    if (normalBounds) mainWindow.setBounds(normalBounds);
    if (wasMaximized) mainWindow.maximize();
  }

  updateActiveViewBounds();
  broadcastState();
}

function toggleAlwaysOnTop() {
  if (!mainWindow) return;
  isAlwaysOnTop = !isAlwaysOnTop;
  if (!isMiniPlayer) mainWindow.setAlwaysOnTop(isAlwaysOnTop, 'normal');
  broadcastState();
  saveWindowState();
}

function registerShortcuts() {
  try {
    globalShortcut.register('MediaPlayPause', () => {
      const activeTab = tabs.find(t => t.id === activeTabId);
      activeTab?.view?.webContents?.send('media-action', 'play-pause');
    });
    globalShortcut.register('MediaNextTrack', () => {
      const activeTab = tabs.find(t => t.id === activeTabId);
      activeTab?.view?.webContents?.send('media-action', 'next');
    });
    globalShortcut.register('MediaPreviousTrack', () => {
      const activeTab = tabs.find(t => t.id === activeTabId);
      activeTab?.view?.webContents?.send('media-action', 'prev');
    });
  } catch (e) {}
}

// Channel Preview Metadata Cache & IPC Handler
const channelMetadataCache = new Map();

async function fetchChannelMetadata(channelPath) {
  if (channelMetadataCache.has(channelPath)) {
    return channelMetadataCache.get(channelPath);
  }

  return new Promise((resolve) => {
    const options = {
      hostname: 'www.youtube.com',
      path: channelPath,
      method: 'GET',
      headers: {
        'User-Agent': CHROME_UA,
        'Accept-Language': 'en-US,en;q=0.9'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const match = data.match(/var ytInitialData = ({.*?});<\/script>/s);
          if (!match) return resolve(null);

          const json = JSON.parse(match[1]);
          const phr = json.header?.pageHeaderRenderer?.content?.pageHeaderViewModel;
          const c4 = json.header?.c4TabbedHeaderRenderer;
          const meta = json.metadata?.channelMetadataRenderer;

          const title = phr?.title?.dynamicTextViewModel?.text?.content || c4?.title || meta?.title || '';
          let handle = '';
          let subs = '';
          let videos = '';

          const rows = phr?.metadata?.contentMetadataViewModel?.metadataRows || [];
          for (const row of rows) {
            for (const part of (row.metadataParts || [])) {
              const txt = part.text?.content || '';
              if (txt.startsWith('@')) handle = txt;
              else if (txt.toLowerCase().includes('subscriber')) subs = txt;
              else if (txt.toLowerCase().includes('video')) videos = txt;
            }
          }

          if (!subs && c4?.subscriberCountText?.simpleText) subs = c4.subscriberCountText.simpleText;
          if (!handle && channelPath.startsWith('/@')) handle = channelPath.slice(1);

          const banner = phr?.banner?.imageBannerViewModel?.image?.sources?.slice(-1)[0]?.url || c4?.banner?.thumbnails?.slice(-1)[0]?.url || '';
          const avatar = phr?.image?.decoratedAvatarViewModel?.avatar?.avatarViewModel?.image?.sources?.slice(-1)[0]?.url || meta?.avatar?.thumbnails?.slice(-1)[0]?.url || '';
          const desc = phr?.description?.descriptionPreviewViewModel?.description?.content || meta?.description || '';

          const result = {
            title: title || handle || 'YouTube Channel',
            handle: handle || channelPath,
            subs: subs.replace(/subscribers/i, '').trim() || '--',
            videos: videos.replace(/videos/i, '').trim() || '--',
            banner,
            avatar,
            desc,
            url: `https://www.youtube.com${channelPath}`
          };

          channelMetadataCache.set(channelPath, result);
          resolve(result);
        } catch (e) {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.end();
  });
}

ipcMain.handle('get-channel-metadata', async (event, channelPath) => {
  return await fetchChannelMetadata(channelPath);
});

ipcMain.on('show-tab-tooltip', (event, data) => {
  const { tabId, title, x } = data || {};
  let finalTitle = title;
  if (tabId) {
    const targetTab = tabs.find(t => t.id === tabId);
    if (targetTab && targetTab.view && !targetTab.view.webContents.isDestroyed()) {
      try {
        const liveTitle = targetTab.view.webContents.getTitle();
        if (liveTitle && liveTitle.trim() && liveTitle !== 'Loading...') {
          finalTitle = liveTitle;
          targetTab.title = liveTitle;
        }
      } catch (e) {}
    }
  }

  const activeTab = tabs.find(t => t.id === activeTabId);
  activeTab?.view?.webContents?.send('show-tab-tooltip', { title: finalTitle, x });
});

ipcMain.on('hide-tab-tooltip', () => {
  const activeTab = tabs.find(t => t.id === activeTabId);
  activeTab?.view?.webContents?.send('hide-tab-tooltip');
});

// IPC Handlers
ipcMain.on('get-initial-tab-state', (event) => {
  const tab = tabs.find(t => t.view && t.view.webContents === event.sender);
  const isActive = tab ? (tab.id === activeTabId) : false;
  event.returnValue = { isActive, tabId: tab ? tab.id : null };
});
ipcMain.on('tab-user-interacted', (event) => {
  const wc = event.sender;
  const tab = tabs.find(t => t.view && t.view.webContents === wc);
  if (tab && tab.view && !tab.view.webContents.isDestroyed()) {
    tab.hasUserInteracted = true;
    tab.view.webContents.setAudioMuted(false);
  }
});

ipcMain.on('create-tab', (event, url) => {
  createTab(url || DEFAULT_HOME_URL, false);
  saveWindowState();
});

// Native context menu on tabs (NEVER cropped!)
ipcMain.on('show-tab-context-menu', (event, { tabId, x, y }) => {
  const tab = tabs.find(t => t.id === tabId);
  const menu = Menu.buildFromTemplate([
    {
      label: 'Reload Tab',
      accelerator: 'CmdOrCtrl+R',
      click: () => tab?.view?.webContents?.reload()
    },
    {
      label: 'Duplicate Tab',
      click: () => {
        if (tab) createTab(tab.url, false);
      }
    },
    { type: 'separator' },
    {
      label: 'Close Tab',
      accelerator: 'CmdOrCtrl+W',
      click: () => closeTab(tabId)
    },
    {
      label: 'Close Other Tabs',
      click: () => {
        tabs.filter(t => t.id !== tabId).forEach(t => closeTab(t.id));
      }
    }
  ]);
  menu.popup({ window: mainWindow, x: x, y: y });
});

// Native History Context Menu for Back and Forward buttons (Chrome Parity)
ipcMain.on('show-nav-history-menu', (event, { type, x, y }) => {
  const activeTab = tabs.find(t => t.id === activeTabId);
  const wc = activeTab?.view?.webContents;
  if (!wc || wc.isDestroyed()) return;

  const nh = wc.navigationHistory;
  if (!nh) return;

  const activeIndex = typeof nh.getActiveIndex === 'function' ? nh.getActiveIndex() : -1;
  const menuTemplate = [];
  const maxEntries = 12;

  if (type === 'back') {
    if (activeIndex <= 0) return;

    let count = 0;
    for (let i = activeIndex - 1; i >= 0 && count < maxEntries; i--, count++) {
      try {
        const entry = nh.getEntryAtIndex(i);
        if (entry && entry.url) {
          const rawTitle = (entry.title && entry.title !== 'Loading...')
            ? entry.title
            : (knownTitles.get(entry.url) || formatHistoryTitle(entry.url));
          const label = truncateTitle(rawTitle, 46);
          const targetIndex = i;
          menuTemplate.push({
            label: label,
            click: () => {
              if (wc && !wc.isDestroyed() && nh) {
                if (typeof nh.goToIndex === 'function') {
                  nh.goToIndex(targetIndex);
                } else if (typeof nh.goToOffset === 'function') {
                  nh.goToOffset(targetIndex - activeIndex);
                }
                setTimeout(broadcastState, 60);
              }
            }
          });
        }
      } catch (e) {}
    }

    if (menuTemplate.length > 0) {
      menuTemplate.push({ type: 'separator' });
      menuTemplate.push({
        label: 'YouTube History',
        click: () => {
          if (wc && !wc.isDestroyed()) {
            wc.loadURL('https://www.youtube.com/feed/history');
          }
        }
      });
    }
  } else if (type === 'forward') {
    if (activeIndex < 0) return;

    let count = 0;
    for (let i = activeIndex + 1; count < maxEntries; i++) {
      let entry = null;
      try {
        entry = nh.getEntryAtIndex(i);
      } catch (err) {
        break; // Reached end of forward history
      }
      if (!entry || !entry.url) {
        break; // Reached end of forward history
      }

      count++;
      const rawTitle = (entry.title && entry.title !== 'Loading...')
        ? entry.title
        : (knownTitles.get(entry.url) || formatHistoryTitle(entry.url));
      const label = truncateTitle(rawTitle, 46);
      const targetIndex = i;
      menuTemplate.push({
        label: label,
        click: () => {
          if (wc && !wc.isDestroyed() && nh) {
            if (typeof nh.goToIndex === 'function') {
              nh.goToIndex(targetIndex);
            } else if (typeof nh.goToOffset === 'function') {
              nh.goToOffset(targetIndex - activeIndex);
            }
            setTimeout(broadcastState, 60);
          }
        }
      });
    }
  }

  if (menuTemplate.length === 0) return;

  const menu = Menu.buildFromTemplate(menuTemplate);
  menu.popup({
    window: mainWindow,
    x: Math.round(x),
    y: Math.round(y)
  });
});

ipcMain.on('open-url-in-new-tab', (event, data) => {
  const url = typeof data === 'string' ? data : data.url;
  const background = typeof data === 'object' ? !!data.background : true;
  createTab(url, background);
  saveWindowState();
});

ipcMain.on('video-started-playing', (event) => {
  const senderWebContents = event.sender;
  const tab = tabs.find(t => t.view && t.view.webContents === senderWebContents);
  if (tab) {
    pauseOtherTabs(tab.id);
  }
});

ipcMain.on('switch-tab', (event, tabId) => {
  switchTab(tabId);
});

ipcMain.on('set-tab-order', (event, orderedTabIds) => {
  if (!Array.isArray(orderedTabIds)) return;
  const tabMap = new Map(tabs.map(t => [t.id, t]));
  const newTabs = [];
  for (const id of orderedTabIds) {
    const tab = tabMap.get(id);
    if (tab) {
      newTabs.push(tab);
      tabMap.delete(id);
    }
  }
  for (const remaining of tabMap.values()) {
    newTabs.push(remaining);
  }
  tabs = newTabs;
  broadcastState();
  saveWindowState();
});

ipcMain.on('close-tab', (event, tabId) => {
  closeTab(tabId);
});

ipcMain.on('close-other-tabs', (event, tabId) => {
  tabs.filter(t => t.id !== tabId).forEach(t => closeTab(t.id));
});

ipcMain.on('duplicate-tab', (event, tabId) => {
  const tab = tabs.find(t => t.id === tabId);
  if (tab) createTab(tab.url, false);
});

ipcMain.on('reload-tab', (event, tabId) => {
  const tab = tabs.find(t => t.id === tabId);
  tab?.view?.webContents?.reload();
});

// Navigation Controls
ipcMain.on('nav-back', () => {
  const activeTab = tabs.find(t => t.id === activeTabId);
  const wc = activeTab?.view?.webContents;
  if (!wc) return;
  if (wc.navigationHistory && wc.navigationHistory.canGoBack()) {
    wc.navigationHistory.goBack();
  } else if (typeof wc.goBack === 'function' && wc.canGoBack()) {
    wc.goBack();
  }
  setTimeout(broadcastState, 50);
});

ipcMain.on('nav-forward', () => {
  const activeTab = tabs.find(t => t.id === activeTabId);
  const wc = activeTab?.view?.webContents;
  if (!wc) return;
  if (wc.navigationHistory && wc.navigationHistory.canGoForward()) {
    wc.navigationHistory.goForward();
  } else if (typeof wc.goForward === 'function' && wc.canGoForward()) {
    wc.goForward();
  }
  setTimeout(broadcastState, 50);
});

ipcMain.on('nav-reload', () => {
  const activeTab = tabs.find(t => t.id === activeTabId);
  activeTab?.view?.webContents?.reload();
});

ipcMain.on('nav-home', () => {
  const activeTab = tabs.find(t => t.id === activeTabId);
  activeTab?.view?.webContents?.loadURL(DEFAULT_HOME_URL);
});

ipcMain.on('search-or-navigate', (event, input) => {
  const activeTab = tabs.find(t => t.id === activeTabId);
  if (!activeTab || !activeTab.view) return;

  const trimmed = input.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    activeTab.view.webContents.loadURL(trimmed);
  } else if (trimmed.includes('.') && !trimmed.includes(' ')) {
    activeTab.view.webContents.loadURL('https://' + trimmed);
  } else {
    activeTab.view.webContents.loadURL('https://www.youtube.com/results?search_query=' + encodeURIComponent(trimmed));
  }
});

ipcMain.on('search-youtube-new-tab', (event, data) => {
  let query = '';
  let insertIndex = -1;
  if (typeof data === 'string') {
    query = data;
  } else if (data && typeof data === 'object') {
    query = data.query || '';
    insertIndex = typeof data.insertIndex === 'number' ? data.insertIndex : -1;
  }
  if (!query || typeof query !== 'string') return;

  const trimmed = query.trim();
  let targetUrl = '';
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    targetUrl = trimmed;
  } else if (trimmed.includes('.') && !trimmed.includes(' ')) {
    targetUrl = 'https://' + trimmed;
  } else {
    targetUrl = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(trimmed);
  }

  createTab(targetUrl, false, insertIndex);
  saveWindowState();
});

ipcMain.on('navigate-tab-url', (event, { tabId, input }) => {
  if (!input || typeof input !== 'string') return;
  const tab = tabs.find(t => t.id === tabId);
  if (!tab || !tab.view || tab.view.webContents.isDestroyed()) return;

  const trimmed = input.trim();
  let targetUrl = '';
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    targetUrl = trimmed;
  } else if (trimmed.includes('.') && !trimmed.includes(' ')) {
    targetUrl = 'https://' + trimmed;
  } else {
    targetUrl = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(trimmed);
  }

  tab.view.webContents.loadURL(targetUrl, { userAgent: CHROME_UA });
});

// Chrome-Parity Drag & Drop IPC Forwarders
ipcMain.on('page-text-drag-start', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('page-text-drag-start');
  }
});

ipcMain.on('page-text-drag-end', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('page-text-drag-end');
  }
});

// Window State Actions
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('window-close', () => mainWindow?.close());
ipcMain.on('toggle-mini-player', () => toggleMiniPlayer());
ipcMain.on('toggle-always-on-top', () => toggleAlwaysOnTop());

app.on('second-instance', () => {
  log('Second instance attempted, restoring mainWindow');
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// App Lifecycle
app.whenReady().then(() => {
  log('app.whenReady fired');
  createWindow();
});

mainWindow = null;

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else mainWindow?.show();
});

app.on('before-quit', () => {
  log('app before-quit fired');
  saveWindowState();
});

app.on('will-quit', () => {
  log('app will-quit fired');
  globalShortcut.unregisterAll();
});
