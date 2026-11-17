const { ipcRenderer } = require('electron');

let tabs = [];
let activeTabId = null;
let isInitialRender = true;
const closingTabIds = new Set();

// DOM Elements
const tabsList = document.getElementById('tabs-list');
const newTabBtn = document.getElementById('new-tab-btn');
const btnPin = document.getElementById('btn-pin');
const ytBrand = document.getElementById('yt-brand');
const dragRegion = document.getElementById('window-drag-region');
const btnBack = document.getElementById('btn-back');
const btnForward = document.getElementById('btn-forward');
const btnReload = document.getElementById('btn-reload');

const tabElements = new Map(); // tabId -> DOM element

// Tab Dragging & Physics State (Google Chrome parity)
let isPointerDown = false;
let isDragging = false;
let isFinishingDrag = false;
let draggedTabId = null;
let draggedEl = null;
let activePointerId = null;
let startPointerX = 0;
let startPointerY = 0;
let dragStartIndex = -1;
let currentTargetIndex = -1;
let tabPitch = 202; // Measured distance between consecutive tab slots
let initialTabLeft = 0;
let tabEls = [];

function resetAllTabTransforms() {
  if (tabsList) {
    for (const child of tabsList.children) {
      child.style.transform = '';
      child.style.transition = '';
      child.classList.remove('dragging');
    }
  }
  if (newTabBtn) {
    newTabBtn.style.transform = '';
    newTabBtn.style.transition = '';
  }
}

function onTabPointerDown(e, tab, el) {
  ipcRenderer.send('hide-tab-tooltip');
  if (e.button !== 0) return; // Left mouse click only
  if (isFinishingDrag) return;
  if (e.target.closest('.tab-close-btn')) return; // Ignore close button click

  isPointerDown = true;
  isDragging = false;
  draggedEl = el;
  draggedTabId = tab.id;
  activePointerId = e.pointerId;
  startPointerX = e.clientX;
  startPointerY = e.clientY;

  try {
    el.setPointerCapture(e.pointerId);
  } catch (err) {}
}

function onTabPointerMove(e) {
  if (!isPointerDown || !draggedEl || isFinishingDrag) return;

  const rawDeltaX = e.clientX - startPointerX;

  // Threshold before initiating visual drag (4px)
  if (!isDragging && Math.abs(rawDeltaX) > 4) {
    isDragging = true;
    ipcRenderer.send('hide-tab-tooltip');
    draggedEl.classList.add('dragging');
    document.body.classList.add('tab-dragging');

    tabEls = Array.from(tabsList.querySelectorAll('.tab-item'));
    dragStartIndex = tabEls.indexOf(draggedEl);
    currentTargetIndex = dragStartIndex;
    initialTabLeft = tabEls[dragStartIndex].getBoundingClientRect().left;

    // Measure exact slot pitch
    if (tabEls.length >= 2) {
      const r0 = tabEls[0].getBoundingClientRect();
      const r1 = tabEls[1].getBoundingClientRect();
      tabPitch = Math.round(r1.left - r0.left);
    } else {
      tabPitch = Math.round(draggedEl.getBoundingClientRect().width + 2);
    }
  }

  if (!isDragging || tabEls.length <= 1) return;

  // Clamping Bounds:
  // 1. Cannot drag past the left edge of the tab strip (keeps brand logo clear)
  const minDeltaX = -dragStartIndex * tabPitch;

  // 2. Can drag freely to the right corner across the empty titlebar up to window controls
  const windowControls = document.getElementById('window-controls');
  const controlsLeft = windowControls ? windowControls.getBoundingClientRect().left : (window.innerWidth - 140);
  const rightCornerLimit = Math.max(
    (tabEls.length - 1 - dragStartIndex) * tabPitch,
    controlsLeft - initialTabLeft - tabPitch - 38
  );
  const clampedDeltaX = Math.max(minDeltaX, Math.min(rightCornerLimit, rawDeltaX));

  // 1. Move dragged tab 1:1 with pointer
  draggedEl.style.transition = 'none';
  draggedEl.style.transform = `translateX(${clampedDeltaX}px)`;

  // 2. Compute target slot index (capped at the end of the stack)
  const slotOffset = Math.round(clampedDeltaX / tabPitch);
  const newTargetIndex = Math.max(0, Math.min(tabEls.length - 1, dragStartIndex + slotOffset));
  currentTargetIndex = newTargetIndex;

  // 3. Smoothly slide neighboring tabs out of the way
  tabEls.forEach((item, idx) => {
    if (idx === dragStartIndex) return;

    let shift = 0;
    if (dragStartIndex < currentTargetIndex) {
      if (idx > dragStartIndex && idx <= currentTargetIndex) {
        shift = -tabPitch;
      }
    } else if (dragStartIndex > currentTargetIndex) {
      if (idx >= currentTargetIndex && idx < dragStartIndex) {
        shift = tabPitch;
      }
    }

    item.style.transform = shift !== 0 ? `translateX(${shift}px)` : '';
    item.style.transition = 'transform 0.16s cubic-bezier(0.2, 0, 0, 1)';
  });

  // 4. Move + button with the last tab ONLY to the right (never to the left)
  if (newTabBtn) {
    const endOfStackDeltaX = (tabEls.length - 1 - dragStartIndex) * tabPitch;
    const plusShift = Math.max(0, clampedDeltaX - endOfStackDeltaX);
    newTabBtn.style.transition = 'none';
    newTabBtn.style.transform = plusShift > 0 ? `translateX(${plusShift}px)` : '';
  }
}

function finishDrag() {
  if (!draggedEl || isFinishingDrag) return;
  isFinishingDrag = true;

  const el = draggedEl;
  const tabId = draggedTabId;
  const wasDragging = isDragging;
  const pId = activePointerId;
  const oldIndex = dragStartIndex;
  const finalTargetIndex = currentTargetIndex;

  try {
    if (pId !== null) {
      el.releasePointerCapture(pId);
    }
  } catch (err) {}

  // Immediately clear pointer tracking so no other event can double-execute
  isPointerDown = false;
  activePointerId = null;

  if (!wasDragging) {
    // Simple click: activate tab immediately
    isDragging = false;
    draggedEl = null;
    draggedTabId = null;
    tabEls = [];
    isFinishingDrag = false;
    document.body.classList.remove('tab-dragging');
    resetAllTabTransforms();

    if (tabId) {
      ipcRenderer.send('switch-tab', tabId);
    }
    return;
  }

  // Smooth Chrome glide animation into final slot (whether shifted or dragged out to the right corner)
  const finalDeltaX = (finalTargetIndex - oldIndex) * tabPitch;
  el.style.transition = 'transform 0.22s cubic-bezier(0.2, 0, 0, 1)';
  el.style.transform = `translateX(${finalDeltaX}px)`;

  // Smoothly glide the + button back into its resting position in sync with the tab
  if (newTabBtn) {
    newTabBtn.style.transition = 'transform 0.22s cubic-bezier(0.2, 0, 0, 1)';
    newTabBtn.style.transform = 'translateX(0px)';
  }

  setTimeout(() => {
    // 1. Clear transforms on all tabs and + button
    resetAllTabTransforms();

    // 2. Clear drag state BEFORE render() so render() is not blocked
    isDragging = false;
    draggedEl = null;
    draggedTabId = null;
    tabEls = [];
    isFinishingDrag = false;
    document.body.classList.remove('tab-dragging');

    // 3. Reorder internal tabs array if changed
    if (finalTargetIndex !== oldIndex && finalTargetIndex >= 0 && finalTargetIndex < tabs.length) {
      const [movedTab] = tabs.splice(oldIndex, 1);
      tabs.splice(finalTargetIndex, 0, movedTab);
      ipcRenderer.send('set-tab-order', tabs.map(t => t.id));
    }

    // 4. Update DOM order
    render();
  }, 220);
}

// Window-level listeners ensure smooth tracking and single-point release
window.addEventListener('pointermove', onTabPointerMove);
window.addEventListener('pointerup', finishDrag);
window.addEventListener('pointercancel', finishDrag);

// Chrome Tab Close Animation (Smooth width collapse to 0)
function closeTabWithAnimation(tabId) {
  ipcRenderer.send('hide-tab-tooltip');
  if (closingTabIds.has(tabId)) return;
  closingTabIds.add(tabId);

  const el = tabElements.get(tabId);
  if (el) {
    el.classList.add('tab-closing');
    setTimeout(() => {
      ipcRenderer.send('close-tab', tabId);
      closingTabIds.delete(tabId);
    }, 180);
  } else {
    ipcRenderer.send('close-tab', tabId);
    closingTabIds.delete(tabId);
  }
}

// Render tabs into DOM
function render() {
  if (isDragging || isFinishingDrag) return; // Keep drag animations uninterrupted

  const currentTabIds = new Set(tabs.map(t => t.id));

  // Remove closed tabs (skipping those actively animating collapse)
  for (const [id, el] of tabElements.entries()) {
    if (!currentTabIds.has(id) && !closingTabIds.has(id)) {
      el.remove();
      tabElements.delete(id);
    }
  }

  // Build / update tabs
  tabs.forEach((tab) => {
    let el = tabElements.get(tab.id);

    if (!el) {
      el = document.createElement('div');
      el.className = 'tab-item';
      el.dataset.tabId = tab.id;

      // Chrome-like smooth opening expansion animation for new tabs
      const shouldAnimateOpen = !isInitialRender;
      if (shouldAnimateOpen) {
        el.classList.add('tab-entering', 'tab-animate');
      }

      // Tab Title Tooltip Hover Listeners (Sleek floating dialog box)
      let tabHoverTimer = null;
      el.addEventListener('pointerenter', () => {
        if (isDragging || isFinishingDrag) return;
        const liveTab = tabs.find(t => t.id === el.dataset.tabId);
        const titleEl = el.querySelector('.tab-title');
        let currentTitle = (liveTab && liveTab.title && liveTab.title !== 'Loading...')
          ? liveTab.title
          : (titleEl && titleEl.textContent && titleEl.textContent !== 'Loading...' ? titleEl.textContent : (liveTab?.title || 'YouTube'));

        const rect = el.getBoundingClientRect();
        const centerX = Math.round(rect.left + rect.width / 2);

        clearTimeout(tabHoverTimer);
        tabHoverTimer = setTimeout(() => {
          ipcRenderer.send('show-tab-tooltip', {
            tabId: el.dataset.tabId,
            title: currentTitle,
            x: centerX
          });
        }, 180);
      });

      el.addEventListener('pointerleave', (e) => {
        if (e.relatedTarget && el.contains(e.relatedTarget)) return;
        clearTimeout(tabHoverTimer);
        ipcRenderer.send('hide-tab-tooltip');
      });

      // Pointer down starts potential drag or click
      el.addEventListener('pointerdown', (e) => onTabPointerDown(e, tab, el));

      // Middle-click to close tab with collapse animation
      el.addEventListener('auxclick', (e) => {
        if (e.button === 1) {
          e.preventDefault();
          e.stopPropagation();
          closeTabWithAnimation(tab.id);
        }
      });

      // Right-click context menu (native, never cropped)
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        ipcRenderer.send('show-tab-context-menu', {
          tabId: tab.id,
          x: Math.round(e.clientX),
          y: Math.round(e.clientY)
        });
      });

      // Favicon
      const favicon = document.createElement('img');
      favicon.className = 'tab-favicon';
      const initialFavicon = tab.favicon || 'https://www.youtube.com/s/desktop/f4124be3/img/favicon.ico';
      favicon.setAttribute('data-src', initialFavicon);
      favicon.src = initialFavicon;
      favicon.onerror = () => {
        favicon.src = 'https://www.youtube.com/s/desktop/f4124be3/img/favicon.ico';
      };

      // Chrome Loading Spinner SVG
      const spinnerSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      spinnerSvg.setAttribute('class', 'tab-spinner');
      spinnerSvg.setAttribute('viewBox', '0 0 16 16');
      spinnerSvg.innerHTML = `
        <circle cx="8" cy="8" r="6" stroke="rgba(255,255,255,0.15)" stroke-width="2" fill="none"/>
        <path d="M14 8a6 6 0 0 0-6-6" stroke="#3ea6ff" stroke-width="2" stroke-linecap="round" fill="none"/>
      `;

      // Title
      const title = document.createElement('span');
      title.className = 'tab-title';
      title.textContent = tab.title || (tab.isLoading ? 'Loading...' : 'YouTube');

      // Audio Indicator Icon
      const audioSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      audioSvg.setAttribute('class', 'tab-audio-icon');
      audioSvg.setAttribute('viewBox', '0 0 24 24');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z');
      audioSvg.appendChild(path);

      // Close Button with crisp SVG icon
      const closeBtn = document.createElement('button');
      closeBtn.className = 'tab-close-btn';
      closeBtn.title = 'Close Tab (Ctrl+W / Middle-Click)';
      closeBtn.innerHTML = `
        <svg viewBox="0 0 9 9" fill="none">
          <path d="M1.5 1.5L7.5 7.5M7.5 1.5L1.5 7.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
        </svg>
      `;

      closeBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
      closeBtn.addEventListener('mousedown', (e) => e.stopPropagation());
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTabWithAnimation(tab.id);
      });

      // Tab Separator
      const separator = document.createElement('div');
      separator.className = 'tab-separator';

      el.appendChild(spinnerSvg);
      el.appendChild(favicon);
      el.appendChild(title);
      el.appendChild(audioSvg);
      el.appendChild(closeBtn);
      el.appendChild(separator);

      tabElements.set(tab.id, el);

      // Trigger smooth open animation
      if (shouldAnimateOpen) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            el.classList.remove('tab-entering');
            setTimeout(() => {
              el.classList.remove('tab-animate');
            }, 200);
          });
        });
      }
    }

    // Ensure correct DOM order without removing/re-inserting already-correct nodes
    if (tabsList.children[tabs.indexOf(tab)] !== el) {
      tabsList.insertBefore(el, tabsList.children[tabs.indexOf(tab)] || null);
    }

    // Update active, loading and audible status ONLY if changed
    const isActive = (tab.id === activeTabId);
    if (el.classList.contains('active') !== isActive) {
      el.classList.toggle('active', isActive);
      if (isActive) {
        try {
          el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
        } catch (e) {}
      }
    }

    const isAudible = !!tab.isAudible;
    if (el.classList.contains('audible') !== isAudible) {
      el.classList.toggle('audible', isAudible);
    }

    const isLoading = (!!tab.isLoading || tab.title === 'Loading...');
    if (el.classList.contains('loading') !== isLoading) {
      el.classList.toggle('loading', isLoading);
    }

    const titleEl = el.querySelector('.tab-title');
    const displayTitle = tab.title || (isLoading ? 'Loading...' : 'YouTube');
    if (titleEl && titleEl.textContent !== displayTitle) {
      titleEl.textContent = displayTitle;
    }

    const faviconEl = el.querySelector('.tab-favicon');
    const targetFavicon = tab.favicon || 'https://www.youtube.com/s/desktop/f4124be3/img/favicon.ico';
    if (faviconEl && faviconEl.getAttribute('data-src') !== targetFavicon) {
      faviconEl.setAttribute('data-src', targetFavicon);
      faviconEl.src = targetFavicon;
    }
  });

  // Update Navigation Controls (Back / Forward) for active tab
  const activeTab = tabs.find(t => t.id === activeTabId);
  if (btnBack) {
    const canBack = !!(activeTab && activeTab.canGoBack);
    btnBack.disabled = !canBack;
    btnBack.classList.toggle('disabled', !canBack);
  }
  if (btnForward) {
    const canForward = !!(activeTab && activeTab.canGoForward);
    btnForward.disabled = !canForward;
    btnForward.classList.toggle('disabled', !canForward);
  }

  // Update compact & tiny responsive modes based on live tab width
  if (tabsList) {
    const firstTab = tabsList.querySelector('.tab-item:not(.tab-closing)');
    if (firstTab) {
      const tabWidth = firstTab.getBoundingClientRect().width;
      tabsList.classList.toggle('tabs-compact', tabWidth < 95);
      tabsList.classList.toggle('tabs-tiny', tabWidth < 55);
    } else {
      tabsList.classList.toggle('tabs-compact', tabs.length >= 7);
      tabsList.classList.toggle('tabs-tiny', tabs.length >= 18);
    }
  }
}

// Coalesce rapid state syncs into a single animation frame to prevent jitter
let renderRafId = null;
function scheduleRender() {
  if (renderRafId) return;
  renderRafId = requestAnimationFrame(() => {
    renderRafId = null;
    render();
  });
}

// Sync from Main Process
ipcRenderer.on('sync-state', (event, state) => {
  if (state.isMaximized !== undefined) {
    document.body.classList.toggle('is-maximized', !!state.isMaximized);
  }
  if (isDragging || isFinishingDrag) return;
  tabs = state.tabs || [];
  activeTabId = state.activeTabId;
  if (btnPin) btnPin.classList.toggle('active', !!state.alwaysOnTop);
  scheduleRender();
  isInitialRender = false;
});

// Window Resize & Wheel Listeners
window.addEventListener('resize', () => {
  scheduleRender();
});

if (tabsList) {
  tabsList.addEventListener('wheel', (e) => {
    if (tabsList.scrollWidth > tabsList.clientWidth) {
      tabsList.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });
}

// Window Drag Region: Double click to toggle maximize
if (dragRegion) {
  dragRegion.addEventListener('dblclick', () => {
    ipcRenderer.send('window-maximize');
  });
}

// Navigation Controls (Chrome-style Single Click, Right-Click History, and Long-Press)
function attachNavControls(btn, type) {
  if (!btn) return;
  let timer = null;
  let didLongPress = false;

  btn.onclick = () => {
    if (btn.disabled || btn.classList.contains('disabled')) return;
    ipcRenderer.send(type === 'back' ? 'nav-back' : 'nav-forward');
  };

  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = btn.getBoundingClientRect();
    ipcRenderer.send('show-nav-history-menu', {
      type,
      x: Math.round(rect.left),
      y: Math.round(rect.bottom + 2)
    });
  });

  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return; // Left mouse click only
    if (btn.disabled || btn.classList.contains('disabled')) return;

    didLongPress = false;
    timer = setTimeout(() => {
      didLongPress = true;
      const rect = btn.getBoundingClientRect();
      ipcRenderer.send('show-nav-history-menu', {
        type,
        x: Math.round(rect.left),
        y: Math.round(rect.bottom + 2)
      });
    }, 420);
  });

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  btn.addEventListener('pointerup', clearTimer);
  btn.addEventListener('pointercancel', clearTimer);
  btn.addEventListener('pointerleave', clearTimer);

  // In capture phase, suppress single click if long-press fired
  btn.addEventListener('click', (e) => {
    if (didLongPress) {
      e.preventDefault();
      e.stopImmediatePropagation();
      didLongPress = false;
    }
  }, true);
}

attachNavControls(btnBack, 'back');
attachNavControls(btnForward, 'forward');

if (btnReload) {
  btnReload.onclick = () => {
    ipcRenderer.send('nav-reload');
  };
}

// Brand click -> Go to Home
if (ytBrand) ytBrand.onclick = () => ipcRenderer.send('nav-home');
if (newTabBtn) newTabBtn.onclick = () => ipcRenderer.send('create-tab');
if (btnPin) btnPin.onclick = () => ipcRenderer.send('toggle-always-on-top');

// Window Controls
const minBtn = document.getElementById('win-min');
const maxBtn = document.getElementById('win-max');
const closeBtn = document.getElementById('win-close');

if (minBtn) minBtn.onclick = () => ipcRenderer.send('window-minimize');
if (maxBtn) maxBtn.onclick = () => ipcRenderer.send('window-maximize');
if (closeBtn) closeBtn.onclick = () => ipcRenderer.send('window-close');

// Global Chrome Keyboard Shortcuts
window.addEventListener('keydown', (e) => {
  const isCtrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  // Ctrl+T: New tab
  if (isCtrl && !e.shiftKey && !e.altKey && key === 't') {
    e.preventDefault();
    ipcRenderer.send('create-tab');
    return;
  }

  // Ctrl+W: Close current tab with animation
  if (isCtrl && !e.shiftKey && !e.altKey && key === 'w') {
    e.preventDefault();
    if (activeTabId) closeTabWithAnimation(activeTabId);
    return;
  }

  // Ctrl+Tab / Ctrl+Shift+Tab: Cycle tabs
  if (isCtrl && !e.altKey && e.key === 'Tab') {
    e.preventDefault();
    const currentIdx = tabs.findIndex(t => t.id === activeTabId);
    if (currentIdx !== -1 && tabs.length > 1) {
      const nextIdx = e.shiftKey
        ? (currentIdx - 1 + tabs.length) % tabs.length
        : (currentIdx + 1) % tabs.length;
      ipcRenderer.send('switch-tab', tabs[nextIdx].id);
    }
    return;
  }

  // Ctrl+1 through Ctrl+8: Switch to tab 1..8
  if (isCtrl && !e.shiftKey && !e.altKey && e.key >= '1' && e.key <= '8') {
    const targetIdx = parseInt(e.key, 10) - 1;
    if (targetIdx < tabs.length) {
      e.preventDefault();
      ipcRenderer.send('switch-tab', tabs[targetIdx].id);
    }
    return;
  }

  // Ctrl+9: Switch to last tab
  if (isCtrl && !e.shiftKey && !e.altKey && e.key === '9') {
    if (tabs.length > 0) {
      e.preventDefault();
      ipcRenderer.send('switch-tab', tabs[tabs.length - 1].id);
    }
    return;
  }

  // Alt+Left Arrow: Go Back
  if (e.altKey && !e.ctrlKey && !e.shiftKey && e.key === 'ArrowLeft') {
    e.preventDefault();
    ipcRenderer.send('nav-back');
    return;
  }

  // Alt+Right Arrow: Go Forward
  if (e.altKey && !e.ctrlKey && !e.shiftKey && e.key === 'ArrowRight') {
    e.preventDefault();
    ipcRenderer.send('nav-forward');
    return;
  }

  // Ctrl+R or F5: Reload active tab
  if ((isCtrl && !e.shiftKey && !e.altKey && key === 'r') || e.key === 'F5') {
    e.preventDefault();
    ipcRenderer.send('nav-reload');
    return;
  }
});

// -------------------------------------------------------------
// Drag & Drop Selected Text to Search YouTube (Google Chrome Parity)
// -------------------------------------------------------------
let textDragDepth = 0;
const tabDropIndicator = document.getElementById('tab-drop-indicator');
let dropTargetState = {
  type: 'none',
  insertIndex: -1,
  tabId: null
};

function clearDropTargetHighlights() {
  const tabs = tabsList ? tabsList.querySelectorAll('.tab-item.drop-target') : [];
  tabs.forEach(t => t.classList.remove('drop-target'));
}

function hasTextTransfer(e) {
  if (isDragging) return false; // Ignore if user is reordering tabs
  if (!e || !e.dataTransfer) return false;
  const types = e.dataTransfer.types;
  if (!types || types.length === 0) return true;
  return types.includes('text/plain') || types.includes('text') || types.includes('text/uri-list');
}

function updateDropIndicator(clientX) {
  clearDropTargetHighlights();
  if (!tabDropIndicator) return dropTargetState;

  const tabEls = Array.from(tabsList ? tabsList.querySelectorAll('.tab-item:not(.tab-closing)') : []);
  const newTabBtnRect = newTabBtn ? newTabBtn.getBoundingClientRect() : null;

  // 1. No tabs present
  if (tabEls.length === 0) {
    const left = newTabBtnRect ? newTabBtnRect.left : 120;
    tabDropIndicator.style.display = 'block';
    tabDropIndicator.style.left = left + 'px';
    dropTargetState = { type: 'new-tab', insertIndex: 0, tabId: null };
    return dropTargetState;
  }

  // 2. Cursor before first tab
  const firstTabRect = tabEls[0].getBoundingClientRect();
  if (clientX < firstTabRect.left + 24) {
    tabDropIndicator.style.display = 'block';
    tabDropIndicator.style.left = Math.round(firstTabRect.left) + 'px';
    dropTargetState = { type: 'new-tab', insertIndex: 0, tabId: null };
    return dropTargetState;
  }

  // 3. Cursor in the empty tabbar space / past all tabs
  const lastTabRect = tabEls[tabEls.length - 1].getBoundingClientRect();
  if (clientX > lastTabRect.right - 24) {
    tabDropIndicator.style.display = 'block';
    const indicatorLeft = Math.round(lastTabRect.right + 1);
    tabDropIndicator.style.left = indicatorLeft + 'px';
    dropTargetState = { type: 'new-tab', insertIndex: tabEls.length, tabId: null };
    return dropTargetState;
  }

  // 4. Hovering over a tab or between tabs
  for (let i = 0; i < tabEls.length; i++) {
    const el = tabEls[i];
    const r = el.getBoundingClientRect();
    if (clientX >= r.left && clientX <= r.right) {
      const edgeThreshold = Math.min(28, r.width * 0.25);
      if (clientX < r.left + edgeThreshold) {
        tabDropIndicator.style.display = 'block';
        tabDropIndicator.style.left = Math.round(r.left) + 'px';
        dropTargetState = { type: 'new-tab', insertIndex: i, tabId: null };
      } else if (clientX > r.right - edgeThreshold) {
        tabDropIndicator.style.display = 'block';
        tabDropIndicator.style.left = Math.round(r.right) + 'px';
        dropTargetState = { type: 'new-tab', insertIndex: i + 1, tabId: null };
      } else {
        // Center of tab: highlight tab, drop will search in this tab (Chrome parity)
        tabDropIndicator.style.display = 'none';
        el.classList.add('drop-target');
        dropTargetState = { type: 'navigate-tab', insertIndex: -1, tabId: el.dataset.tabId };
      }
      return dropTargetState;
    }
  }

  // Fallback (dock to end of tabs)
  tabDropIndicator.style.display = 'block';
  tabDropIndicator.style.left = Math.round(lastTabRect.right + 1) + 'px';
  dropTargetState = { type: 'new-tab', insertIndex: tabEls.length, tabId: null };
  return dropTargetState;
}

let isPageTextDragging = false;
let dragoverResetTimer = null;

function enableDropUI(e) {
  document.body.classList.add('is-dropping-text');
  if (e && e.clientY <= 45) {
    updateDropIndicator(e.clientX);
  }
}

function disableDropUI() {
  clearTimeout(dragoverResetTimer);
  dragoverResetTimer = null;
  document.body.classList.remove('is-dropping-text');
  if (tabDropIndicator) {
    tabDropIndicator.style.display = 'none';
  }
  clearDropTargetHighlights();
  dropTargetState = { type: 'none', insertIndex: -1, tabId: null };
}

ipcRenderer.on('page-text-drag-start', () => {
  isPageTextDragging = true;
  enableDropUI();
});

ipcRenderer.on('page-text-drag-end', () => {
  isPageTextDragging = false;
  disableDropUI();
});

window.addEventListener('dragenter', (e) => {
  if (hasTextTransfer(e)) {
    e.preventDefault();
    enableDropUI(e);
  }
});

window.addEventListener('dragover', (e) => {
  if (hasTextTransfer(e)) {
    e.preventDefault();
    try {
      e.dataTransfer.dropEffect = 'copy';
    } catch (err) {}

    if (!document.body.classList.contains('is-dropping-text')) {
      enableDropUI(e);
    }

    // For external drags (e.g. from another app), maintain heartbeat timeout
    if (!isPageTextDragging) {
      clearTimeout(dragoverResetTimer);
      dragoverResetTimer = setTimeout(() => {
        if (!isPageTextDragging) {
          disableDropUI();
        }
      }, 400);
    }

    if (e.clientY <= 45) {
      updateDropIndicator(e.clientX);
    } else {
      if (tabDropIndicator) tabDropIndicator.style.display = 'none';
      clearDropTargetHighlights();
    }
  }
});

window.addEventListener('dragleave', (e) => {
  // If moving out of tabbar vertically or leaving the window, hide visual indicators
  if (e.clientY > 45 || e.clientY <= 0 || e.clientX <= 0 || e.clientX >= window.innerWidth) {
    if (tabDropIndicator) tabDropIndicator.style.display = 'none';
    clearDropTargetHighlights();
  }
});

window.addEventListener('drop', (e) => {
  const target = (e.clientY <= 45) ? updateDropIndicator(e.clientX) : { ...dropTargetState };
  isPageTextDragging = false;
  disableDropUI();

  if (!e.dataTransfer) return;
  const text = e.dataTransfer.getData('text/plain') ||
               e.dataTransfer.getData('text') ||
               e.dataTransfer.getData('text/uri-list') || '';

  if (!text || !text.trim()) return;

  // Don't trigger if dropped on window controls (minimize, maximize, close)
  if (e.target.closest('#window-controls')) return;

  e.preventDefault();
  e.stopPropagation();

  const query = text.trim();
  if (target.type === 'navigate-tab' && target.tabId) {
    ipcRenderer.send('navigate-tab-url', { tabId: target.tabId, input: query });
  } else {
    const insertIndex = target.insertIndex >= 0 ? target.insertIndex : -1;
    ipcRenderer.send('search-youtube-new-tab', { query, insertIndex });
  }
});
