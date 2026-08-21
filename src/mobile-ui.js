/**
 * mobile-ui.js — tiny runtime helpers for the Freebuff Desktop browser UI on
 * phones. Pairs with mobile-ui.css; injected by the tailnet proxy.
 *
 *   1. Patch the viewport meta: enable viewport-fit=cover (so env()
 *      safe-area insets are usable) and kill double-tap zoom on the app UI.
 *   2. Track the visual viewport height and expose it as --fb-vh, so CSS can
 *      dodge the mobile URL-bar shrink/grow dance (fallback to 100dvh).
 *   3. Auto-collapse the explorer panel on narrow viewports. The desktop app
 *      starts with the explorer OPEN, which on a phone hides the entire
 *      message stream behind the full-screen drawer. Clicking the app's own
 *      collapse toggle lets the app persist the state (uiPrefs.explorerCollapsed),
 *      so the chat is fully visible and stays that way across reloads.
 *   4. Session switcher (mobile): the tab strip is hidden on phones (slim
 *      header), so a header button opens a dropdown of the open sessions.
 *      Choosing one clicks the app's own .tab-select (native activation);
 *      "New session" clicks .tab-new and "All sessions" clicks the home tab.
 *
 * TIMING NOTE: the app's bundle is a deferred module in <head>, and React
 * mounts its UI after parse — so when this script executes, document.body is
 * usually null. Every feature that touches app DOM goes through waitForEl()
 * (or polls), so bindings happen once React has mounted.
 */
/* Clipboard fallback: the app's copy buttons (referral link, code blocks)
 * call navigator.clipboard.writeText, which browsers only expose in a secure
 * context (https or localhost). Over plain http on a tailnet IP the API is
 * missing and every copy silently no-ops. Shim it with a hidden textarea +
 * execCommand('copy') (still allowed inside a user gesture), so copy works
 * from any host. The fallback only touches the DOM when a copy is actually
 * requested, so it is safe here even though document.body may not exist yet. */
(function () {
  var native = null;
  try {
    native = window.navigator.clipboard;
  } catch (e) {
    native = null;
  }
  if (native && typeof native.writeText === 'function') return;
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = String(text);
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    var sel = window.getSelection();
    var prev = [];
    for (var i = 0; i < sel.rangeCount; i++) {
      prev.push(sel.getRangeAt(i).cloneRange());
    }
    var range = document.createRange();
    range.selectNodeContents(ta);
    sel.removeAllRanges();
    sel.addRange(range);
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e) {
      ok = false;
    }
    sel.removeAllRanges();
    for (var j = 0; j < prev.length; j++) sel.addRange(prev[j]);
    ta.remove();
    return ok;
  }
  var shim = {
    writeText: function (text) {
      if (native && typeof native.writeText === 'function') {
        return native.writeText(text);
      }
      return fallbackCopy(text)
        ? Promise.resolve()
        : Promise.reject(new Error('Copy failed'));
    },
    readText: function () {
      if (native && typeof native.readText === 'function') {
        return native.readText();
      }
      return Promise.reject(new Error('readText unavailable'));
    },
  };
  try {
    Object.defineProperty(window.navigator, 'clipboard', {
      value: shim,
      configurable: true,
      writable: true,
    });
  } catch (e) {
    try {
      window.navigator.clipboard = shim;
    } catch (e2) {}
  }
})();
(function () {
  'use strict';

  var MOBILE = '(max-width: 1000px)';

  // Accessibility: on-demand larger chat text, persisted per device. Applied
  // on every page (including popouts) before the app paints, so no flash.
  var root = document.documentElement;
  var TEXT_KEY = 'fb-ui:text-large';
  try {
    if (localStorage.getItem(TEXT_KEY) === '1') {
      root.classList.add('fb-text-large');
    }
  } catch (e) {}

  // Theme selection (all viewports): the header theme menu (themePicker
  // below) switches between the app's own dark theme and the built-in
  // Cyberpunk 2077 theme. The choice persists per browser in localStorage
  // and is applied here, before the app paints, so a reload never flashes
  // the wrong theme. The attribute is namespaced (data-fb-theme) and lives
  // beside the app's own data-theme (dark/light switch), which it overrides
  // while active — the injected stylesheet wins because it is served after
  // the app's CSS.
  var THEME_KEY = 'fb-ui:theme';
  var THEME_CYBERPUNK = 'cyberpunk';
  var THEME_DEFAULT = 'default';
  function persistedTheme() {
    try {
      var v = localStorage.getItem(THEME_KEY);
      return v && v !== THEME_DEFAULT ? v : THEME_DEFAULT;
    } catch (e) {
      return THEME_DEFAULT;
    }
  }
  (function applyPersistedTheme() {
    var pt = persistedTheme();
    if (pt !== THEME_DEFAULT) root.setAttribute('data-fb-theme', pt);
  })();

  // Active session thread id, from the active tab's .tab-select id
  // ("thread-tab-<id>"). Empty on the home screen.
  function activeThreadId() {
    var tab = document.querySelector('.tab.active:not(.home)');
    if (!tab) return '';
    var s = tab.querySelector('.tab-select');
    if (!s || !s.id) return '';
    return s.id.indexOf('thread-tab-') === 0 ? s.id.slice(11) : s.id;
  }

  // Per-thread state maps, shared by the panel/card and migrated from the
  // old single-thread scalar values written by earlier mobile layers.
  var PANEL_KEY = 'fb-ui:panel-open-thread';
  function threadStateRead(key) {
    var raw = '';
    try {
      raw = localStorage.getItem(key) || '';
    } catch (e) {
      return {};
    }
    if (!raw) return {};
    try {
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
      if (typeof parsed === 'string' && parsed) {
        var quoted = {};
        quoted[parsed] = true;
        return quoted;
      }
    } catch (e) {
      // The previous implementation stored the thread ID as plain text.
      var legacy = {};
      legacy[raw] = true;
      return legacy;
    }
    return {};
  }
  function threadStateHas(key, id) {
    return !!id && threadStateRead(key)[id] === true;
  }
  function threadStateSet(key, id, open) {
    if (!id) return;
    var states = threadStateRead(key);
    if (open) states[id] = true;
    else delete states[id];
    try {
      localStorage.setItem(key, JSON.stringify(states));
    } catch (e) {}
  }

  // Compact relative timestamp, same style as the app's own thread catalog
  // ("now", "5m", "2h", "12d", then a short date).
  function relTime(ts) {
    if (!ts) return '';
    var t = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (t < 60) return 'now';
    var n = Math.floor(t / 60);
    if (n < 60) return n + 'm';
    var h = Math.floor(n / 60);
    if (h < 24) return h + 'h';
    var d = Math.floor(h / 24);
    if (d < 30) return d + 'd';
    return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  // Run fn once an element matching selector exists (React may mount it after
  // this script executes — see TIMING NOTE). Cheap 80ms poll; gives up after
  // timeout ms (default 20s) so elements that never appear in this window
  // (e.g. the popout header in the main window) don't poll forever.
  function waitForEl(selector, fn, timeout) {
    timeout = timeout || 20000;
    var start = Date.now();
    var timer = setInterval(function () {
      if (document.querySelector(selector)) {
        clearInterval(timer);
        fn();
      } else if (Date.now() - start > timeout) {
        clearInterval(timer);
      }
    }, 80);
  }

  // React mounts large transcripts in many small commits. A separate
  // document-wide observer per mobile feature can monopolize a phone's main
  // thread while the initial thread is loading. Share one observer, start it
  // just after the app shell mounts, and coalesce child-list changes. Class
  // changes are watched only by the small feature-specific observers below;
  // watching every class mutation in the transcript is an expensive no-op.
  var bodySyncListeners = [];
  var bodySyncObserver = null;
  var bodySyncQueued = false;
  var bodySyncTimer = null;
  function scheduleBodySync() {
    if (bodySyncQueued || !window.matchMedia(MOBILE).matches) return;
    bodySyncQueued = true;
    bodySyncTimer = window.setTimeout(function () {
      bodySyncTimer = null;
      bodySyncQueued = false;
      var listeners = bodySyncListeners.slice();
      listeners.forEach(function (listener) {
        try {
          listener();
        } catch (e) {
          // One optional mobile affordance must not break thread rendering.
          if (window.console && console.error) {
            console.error('Freebuff mobile enhancement failed', e);
          }
        }
      });
    }, 80);
  }
  function isTranscriptNode(node) {
    var element =
      node && node.nodeType === 1
        ? node
        : node && node.parentElement
          ? node.parentElement
          : null;
    if (!element || !element.closest) return false;
    // Transcript mutations are the streaming/rendering hot path; skip them.
    if (element.closest('.messages, .thread-transcript')) return true;
    // The composer's textarea mutates on every keystroke (controlled draft
    // state). The narrow composer observer below already covers the class
    // changes that matter, so typing must not schedule global layout work.
    if (element.closest('.composer')) return true;
    return false;
  }
  function watchMobileBody(fn) {
    if (typeof fn !== 'function') return;
    bodySyncListeners.push(fn);
    if (bodySyncObserver) {
      scheduleBodySync();
      return;
    }
    // Give native workspace bootstrap a head start. Mobile layer is optional
    // chrome; it must never compete with first thread requests or stream
    // token updates.
    waitForEl('.app', function () {
      window.setTimeout(function () {
        if (bodySyncObserver || !document.body) {
          scheduleBodySync();
          return;
        }
        bodySyncObserver = new MutationObserver(function (records) {
          // Streaming replies append/mutate transcript nodes constantly. None
          // of those changes can mount a mobile trigger or popup, so ignore
          // them; otherwise every token competes with a user's tap.
          if (
            records.some(function (record) {
              return !isTranscriptNode(record.target);
            })
          ) {
            scheduleBodySync();
          }
        });
        bodySyncObserver.observe(document.body, {
          childList: true,
          subtree: true,
        });
        scheduleBodySync();
      }, 250);
    });
  }

  // Shared collision-aware layout for mobile floating cards. Header menus and
  // context cards keep their native anchor; persistent task card moves below
  // them and stops above composer controls. This stays outside transcript
  // observers so streaming token mutations do not trigger layout work.
  var floatLayoutBound = false;
  var floatLayoutRaf = null;
  var floatLayoutResizeObserver = null;
  var floatLayoutMutationObserver = null;
  var floatLayoutObserved = [];
  var FLOAT_BLOCKER_SELECTOR =
    '.fb-tab-menu, .fb-session-menu, .fb-ctx-open .composer-context, ' +
    '.agent-menu, .header-menu, .account-menu, .effort-menu, .stash-menu, ' +
    '.slash-menu, .home-context-menu, .context-usage-popover, ' +
    '.open-in-menu, .new-thread-project-menu';

  function isMobileFloatVisible(element) {
    if (!element || !document.documentElement.contains(element)) return false;
    if (element.hidden || element.getAttribute('aria-hidden') === 'true') {
      return false;
    }
    var style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    var rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function observeMobileFloatElements(elements) {
    var unique = [];
    elements.forEach(function (element) {
      if (!element || unique.indexOf(element) >= 0) return;
      unique.push(element);
    });

    if (typeof window.ResizeObserver === 'function') {
      if (!floatLayoutResizeObserver) {
        floatLayoutResizeObserver = new window.ResizeObserver(
          scheduleFloatLayout,
        );
      }
      floatLayoutObserved.forEach(function (element) {
        if (unique.indexOf(element) < 0) {
          floatLayoutResizeObserver.unobserve(element);
        }
      });
      unique.forEach(function (element) {
        if (floatLayoutObserved.indexOf(element) < 0) {
          floatLayoutResizeObserver.observe(element);
        }
      });
      floatLayoutObserved = unique;
    }

    if (typeof window.MutationObserver === 'function') {
      if (!floatLayoutMutationObserver) {
        floatLayoutMutationObserver = new window.MutationObserver(function (records) {
          // Typing in the composer re-renders its subtree on every keystroke
          // (controlled draft state), firing childList mutations here. Text
          // edits never move the task card: the composer's size is tracked by
          // the ResizeObserver above and its class/style by the attribute
          // filter. Running syncFloatLayout per keystroke forces a full
          // layout (getBoundingClientRect + CSS var writes) and stutters
          // typing on phones. Skip childList changes inside the composer;
          // attribute changes (class/style) still pass through.
          var meaningful = records.some(function (record) {
            if (record.type === 'childList') {
              var target =
                record.target && record.target.nodeType === 1
                  ? record.target
                  : record.target && record.target.parentElement
                    ? record.target.parentElement
                    : null;
              if (target && target.closest && target.closest('.composer')) {
                return false;
              }
            }
            return true;
          });
          if (meaningful) scheduleFloatLayout();
        });
      }
      floatLayoutMutationObserver.disconnect();
      unique.forEach(function (element) {
        floatLayoutMutationObserver.observe(element, {
          attributes: true,
          attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
          childList: true,
          subtree: true,
        });
      });
    }
  }

  function resetFloatLayout() {
    root.style.removeProperty('--fb-mobile-todo-top');
    root.style.removeProperty('--fb-mobile-todo-max-height');
    root.style.removeProperty('--fb-mobile-todo-list-max-height');
    document
      .querySelectorAll('.thread-bottom .todo-dock.fb-float-collision-hidden')
      .forEach(function (element) {
        element.classList.remove('fb-float-collision-hidden');
      });
    if (floatLayoutMutationObserver) floatLayoutMutationObserver.disconnect();
    if (floatLayoutResizeObserver) {
      floatLayoutObserved.forEach(function (element) {
        floatLayoutResizeObserver.unobserve(element);
      });
    }
    floatLayoutObserved = [];
  }

  function scheduleFloatLayout() {
    if (!window.matchMedia(MOBILE).matches) {
      resetFloatLayout();
      return;
    }
    if (floatLayoutRaf !== null) return;
    var run = function () {
      floatLayoutRaf = null;
      syncFloatLayout();
    };
    floatLayoutRaf = window.requestAnimationFrame
      ? window.requestAnimationFrame(run)
      : window.setTimeout(run, 0);
  }

  function syncFloatLayout() {
    if (!window.matchMedia(MOBILE).matches) {
      resetFloatLayout();
      return;
    }

    var task = document.querySelector('.thread-bottom .todo-dock');
    if (!task) {
      resetFloatLayout();
      return;
    }

    var header = document.querySelector(
      '.tabbar:not(.threadbar), .tabbar.threadbar',
    );
    var headerBottom = 48;
    if (isMobileFloatVisible(header)) {
      headerBottom = header.getBoundingClientRect().bottom;
    }
    var gap = 8;
    var taskTop = Math.max(0, Math.ceil(headerBottom + gap));
    var composer = document.querySelector('.composer');
    var pills = document.querySelector('.fb-composer-pills');
    var blockers = [];
    document.querySelectorAll(FLOAT_BLOCKER_SELECTOR).forEach(function (element) {
      if (isMobileFloatVisible(element)) blockers.push(element);
    });

    // Full-screen sheets already cover every lower layer. Hide the task card
    // while one is open instead of leaving a focusable control underneath it.
    var modelSheet =
      window.matchMedia('(max-width: 700px)').matches &&
      document.querySelector('.composer-context .agent-menu');
    var modal = document.querySelector('.modal-backdrop');
    var observed = [task, composer, pills, modelSheet, modal].concat(blockers);
    if (isMobileFloatVisible(modelSheet) || isMobileFloatVisible(modal)) {
      task.classList.add('fb-float-collision-hidden');
      root.style.setProperty('--fb-mobile-todo-top', taskTop + 'px');
      root.style.setProperty('--fb-mobile-todo-max-height', '0px');
      root.style.setProperty('--fb-mobile-todo-list-max-height', '0px');
      observeMobileFloatElements(observed);
      return;
    }

    var taskLeft = 8;
    var taskRight = Math.max(taskLeft, window.innerWidth - 8);
    blockers.forEach(function (element) {
      var rect = element.getBoundingClientRect();
      var overlapsHorizontally = rect.right > taskLeft && rect.left < taskRight;
      if (overlapsHorizontally && rect.bottom > taskTop) {
        taskTop = Math.max(taskTop, Math.ceil(rect.bottom + gap));
      }
    });

    var viewportHeight =
      window.visualViewport && window.visualViewport.height
        ? window.visualViewport.height
        : window.innerHeight;
    var bottom = Math.max(0, viewportHeight - gap);
    if (isMobileFloatVisible(composer)) {
      bottom = Math.min(bottom, composer.getBoundingClientRect().top - gap);
    }
    if (isMobileFloatVisible(pills)) {
      bottom = Math.min(bottom, pills.getBoundingClientRect().top - gap);
    }

    var available = Math.floor(bottom - taskTop);
    var hidden = available < 56;
    var maxHeight = Math.max(0, Math.min(300, available));
    task.classList.toggle('fb-float-collision-hidden', hidden);
    root.style.setProperty('--fb-mobile-todo-top', taskTop + 'px');
    root.style.setProperty(
      '--fb-mobile-todo-max-height',
      (hidden ? 0 : maxHeight) + 'px',
    );
    root.style.setProperty(
      '--fb-mobile-todo-list-max-height',
      (hidden ? 0 : Math.max(0, maxHeight - 48)) + 'px',
    );
    observeMobileFloatElements(observed);
  }

  function bindFloatLayout() {
    if (!floatLayoutBound) {
      floatLayoutBound = true;
      watchMobileBody(scheduleFloatLayout);
      window.addEventListener('resize', scheduleFloatLayout, { passive: true });
      window.addEventListener('orientationchange', scheduleFloatLayout, {
        passive: true,
      });
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', scheduleFloatLayout, {
          passive: true,
        });
      }
    }
    scheduleFloatLayout();
  }

  // Unified mobile overlay stack. Custom overlays register their native
  // close function; app-owned menus/modals are discovered below and closed
  // with the app's own Escape/backdrop behavior. One history entry represents
  // the whole stack, so browser Back dismisses overlays before navigation.
  var mobileOverlay = (function () {
    var stack = [];
    var active = false;
    var historyArmed = false;
    var handlingPop = false;
    var suppressHistory = 0;
    var historyCloseTimer = null;
    var nativeObserverStarted = false;

    function find(id) {
      for (var i = 0; i < stack.length; i++) {
        if (stack[i].id === id) return stack[i];
      }
      return null;
    }
    function copyHistoryState() {
      var state = {};
      if (history.state && typeof history.state === 'object') {
        for (var key in history.state) state[key] = history.state[key];
      }
      state.__fbMobileOverlay = true;
      return state;
    }
    function armHistory() {
      if (historyArmed) return;
      try {
        history.pushState(copyHistoryState(), '', window.location.href);
        historyArmed = true;
      } catch (e) {}
    }
    function consumeHistory() {
      if (!historyArmed || handlingPop) return;
      historyArmed = false;
      try {
        history.back();
      } catch (e) {}
    }
    function cancelScheduledHistory() {
      if (historyCloseTimer) {
        clearTimeout(historyCloseTimer);
        historyCloseTimer = null;
      }
    }
    function scheduleHistoryConsumption() {
      if (historyCloseTimer || handlingPop) return;
      historyCloseTimer = setTimeout(function () {
        historyCloseTimer = null;
        if (!stack.length && historyArmed && !suppressHistory) {
          consumeHistory();
        }
      }, 0);
    }
    function callClose(entry, info) {
      try {
        entry.close(info || { fromManager: true });
      } catch (e) {}
    }
    function remove(id) {
      var next = [];
      var removed = false;
      for (var i = 0; i < stack.length; i++) {
        var entry = stack[i];
        if (entry.id === id || entry.parent === id) removed = true;
        else next.push(entry);
      }
      stack = next;
      return removed;
    }
    function dismiss(id) {
      var children = [];
      for (var i = stack.length - 1; i >= 0; i--) {
        if (stack[i].parent === id) children.push(stack[i]);
      }
      if (children.length) {
        suppressHistory++;
        for (var j = 0; j < children.length; j++) {
          callClose(children[j], { fromManager: true });
        }
        suppressHistory--;
      }
      if (!remove(id)) return;
      scheduleFloatLayout();
      if (!stack.length && !handlingPop && !suppressHistory) {
        scheduleHistoryConsumption();
      }
    }
    function closeAll(info, keepHistory) {
      cancelScheduledHistory();
      var entries = stack.slice().reverse();
      stack = [];
      suppressHistory++;
      for (var i = 0; i < entries.length; i++) callClose(entries[i], info);
      suppressHistory--;
      if (!keepHistory && !handlingPop) consumeHistory();
    }
    function open(id, close, options) {
      if (!id || typeof close !== 'function') return;
      cancelScheduledHistory();
      var existing = find(id);
      if (existing) {
        existing.close = close;
        existing.parent = (options && options.parent) || existing.parent || '';
        return;
      }
      var parent = (options && options.parent) || '';
      if (parent) {
        var parentIndex = -1;
        for (var i = 0; i < stack.length; i++) {
          if (stack[i].id === parent) {
            parentIndex = i;
            break;
          }
        }
        if (parentIndex >= 0) {
          while (stack.length > parentIndex + 1) {
            var child = stack.pop();
            suppressHistory++;
            callClose(child, { fromManager: true });
            suppressHistory--;
          }
        } else {
          closeAll({ fromManager: true }, true);
        }
      } else if (stack.length) {
        closeAll({ fromManager: true }, true);
      }
      stack.push({ id: id, close: close, parent: parent });
      scheduleFloatLayout();
      if (active) armHistory();
    }
    function onPopState() {
      cancelScheduledHistory();
      if (!stack.length) {
        historyArmed = false;
        return;
      }
      var entry = stack.pop();
      handlingPop = true;
      suppressHistory++;
      callClose(entry, { fromManager: true, fromBack: true });
      suppressHistory--;
      handlingPop = false;
      historyArmed = false;
      if (stack.length && active) armHistory();
    }
    function dispatchEscape(element) {
      var target = element || document;
      try {
        target.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
          }),
        );
      } catch (e) {}
    }
    function closeNative(element) {
      if (!element) return;
      if (element.classList.contains('modal-backdrop')) {
        element.dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
        );
      } else {
        dispatchEscape(element);
      }
    }
    function isVisible(element) {
      if (!element || element.hidden) return false;
      if (element.getAttribute('aria-hidden') === 'true') return false;
      if (window.getComputedStyle) {
        var style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') {
          return false;
        }
      }
      return !element.getClientRects || element.getClientRects().length > 0;
    }
    function nativeMenu() {
      var selector =
        '.agent-menu, .header-menu, .account-menu, .effort-menu, .stash-menu, ' +
        '.slash-menu, .home-context-menu, .context-usage-popover, ' +
        '.open-in-menu, .new-thread-project-menu, .menu-scrim';
      var candidates = document.querySelectorAll(selector);
      var narrowPhone = window.matchMedia('(max-width: 700px)').matches;
      for (var i = candidates.length - 1; i >= 0; i--) {
        var candidate = candidates[i];
        if (
          narrowPhone &&
          candidate.matches('.composer-context .agent-menu')
        ) {
          continue; // modelSheet() owns the full-screen version
        }
        if (!isVisible(candidate)) continue;
        return candidate;
      }
      return null;
    }
    function startNativeObserver() {
      if (nativeObserverStarted) return;
      nativeObserverStarted = true;
      waitForEl('body', function () {
        function sync() {
          if (!active || !window.matchMedia(MOBILE).matches) {
            dismiss('native-modal');
            dismiss('native-menu');
            return;
          }
          var modal = null;
          var modals = document.querySelectorAll('.modal-backdrop');
          for (var i = modals.length - 1; i >= 0; i--) {
            if (isVisible(modals[i])) {
              modal = modals[i];
              break;
            }
          }
          if (modal) {
            open(
              'native-modal',
              function () {
                closeNative(modal);
              },
            );
            return;
          }
          dismiss('native-modal');
          var menu = nativeMenu();
          if (menu) {
            var parent =
              menu.closest && menu.closest('.composer-context')
                ? 'context-card'
                : '';
            open(
              'native-menu',
              function () {
                closeNative(menu);
              },
              parent ? { parent: parent } : null,
            );
          } else {
            dismiss('native-menu');
          }
        }
        watchMobileBody(sync);
        sync();
      });
    }
    window.addEventListener('popstate', onPopState);
    return {
      activate: function () {
        active = true;
        startNativeObserver();
      },
      deactivate: function () {
        active = false;
        closeAll({ fromManager: true, preserveState: true }, false);
      },
      open: open,
      dismiss: dismiss,
    };
  })();

  // Shared live status for session selection and close outcomes. Keep region
  // mounted after first use so screen readers receive repeated state changes.
  var mobileLiveRegion = (function () {
    var region = null;
    var announceTimer = null;

    function getRegion() {
      if (region && document.documentElement.contains(region)) return region;
      if (!document.body) return null;
      region = document.createElement('div');
      region.className = 'fb-mobile-live-region';
      region.setAttribute('role', 'status');
      region.setAttribute('aria-live', 'polite');
      region.setAttribute('aria-atomic', 'true');
      document.body.appendChild(region);
      return region;
    }

    function announce(message, politeness) {
      if (!message) return;
      var target = getRegion();
      if (!target) return;
      if (announceTimer) window.clearTimeout(announceTimer);
      target.setAttribute('aria-live', politeness || 'polite');
      target.textContent = '';
      announceTimer = window.setTimeout(function () {
        announceTimer = null;
        if (target && document.documentElement.contains(target)) {
          target.textContent = message;
        }
      }, 0);
    }

    return { announce: announce };
  })();

  // Session-close confirmation shared by mobile session surfaces. The native
  // tab close remains source of truth; confirmation only delays its click.
  // Parent overlay stays mounted while the dialog is open, so No returns to
  // the session menu instead of losing the user's place.
  var closeSessionConfirm = (function () {
    var overlay = null;
    var pending = null;
    var restoreFocus = null;

    function focusPrevious() {
      var previous = restoreFocus;
      restoreFocus = null;
      if (
        previous &&
        previous !== document.body &&
        document.documentElement.contains(previous) &&
        typeof previous.focus === 'function'
      ) {
        previous.focus();
      }
    }

    function close(reason) {
      var task = pending;
      var cancelled =
        reason === 'cancelled' || !!(reason && reason.fromBack);
      if (overlay) {
        overlay.remove();
        overlay = null;
      }
      pending = null;
      mobileOverlay.dismiss('session-close-confirm');
      focusPrevious();
      if (cancelled && task) {
        mobileLiveRegion.announce(
          'Session “' + task.label + '” kept open.',
          'polite',
        );
      }
    }

    function accept() {
      var task = pending;
      var action = task && task.action;
      close('accepted');
      var closed = action ? action() : false;
      if (task) {
        mobileLiveRegion.announce(
          closed
            ? 'Session “' + task.label + '” closed.'
            : 'Session “' + task.label + '” could not be closed.',
          'polite',
        );
      }
    }

    function request(tab, action, parent) {
      if (!tab || typeof action !== 'function') return;
      close();
      restoreFocus = document.activeElement;
      var titleNode = tab.querySelector('.tab-title');
      var title = titleNode && titleNode.textContent.trim();
      var label = title || 'this session';
      pending = { action: action, label: label };

      overlay = document.createElement('div');
      overlay.className = 'fb-session-close-confirm';
      overlay.setAttribute('role', 'presentation');

      var dialog = document.createElement('section');
      dialog.className = 'fb-session-close-dialog';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', 'fb-session-close-title');
      dialog.setAttribute('aria-describedby', 'fb-session-close-copy');

      var heading = document.createElement('h2');
      heading.id = 'fb-session-close-title';
      heading.className = 'fb-session-close-title';
      heading.textContent = 'Close session?';
      dialog.appendChild(heading);

      var copy = document.createElement('p');
      copy.id = 'fb-session-close-copy';
      copy.className = 'fb-session-close-copy';
      copy.textContent =
        'Close “' + label + '”? You can reopen it from Recent sessions.';
      dialog.appendChild(copy);

      var announcement = document.createElement('p');
      announcement.className = 'fb-session-close-announcement';
      announcement.setAttribute('role', 'status');
      announcement.setAttribute('aria-live', 'assertive');
      announcement.setAttribute('aria-atomic', 'true');
      announcement.textContent =
        'Confirmation required for “' +
        label +
        '”. Choose Yes to close session or No to keep it open.';
      dialog.appendChild(announcement);

      var actions = document.createElement('div');
      actions.className = 'fb-session-close-actions';
      var no = document.createElement('button');
      no.type = 'button';
      no.className = 'fb-session-close-no';
      no.textContent = 'No';
      no.addEventListener('click', function () {
        close('cancelled');
      });
      var yes = document.createElement('button');
      yes.type = 'button';
      yes.className = 'fb-session-close-yes';
      yes.textContent = 'Yes';
      yes.addEventListener('click', accept);
      actions.appendChild(no);
      actions.appendChild(yes);
      dialog.appendChild(actions);
      overlay.appendChild(dialog);
      overlay.addEventListener('click', function (event) {
        if (event.target === overlay) close('cancelled');
      });
      overlay.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close('cancelled');
        }
      });
      document.body.appendChild(overlay);
      mobileOverlay.open(
        'session-close-confirm',
        close,
        parent ? { parent: parent } : null,
      );
      no.focus();
    }

    return { request: request };
  })();

  // Session-delete confirmation, same visual family as the close dialog.
  // Deleting a session is destructive and permanent, so it always requires
  // an explicit Yes (red) — No / Escape / backdrop / Back all cancel. The
  // parent sheet stays mounted so cancel returns to the list.
  var deleteSessionConfirm = (function () {
    var overlay = null;
    var pending = null;
    var restoreFocus = null;

    function focusPrevious() {
      var previous = restoreFocus;
      restoreFocus = null;
      if (
        previous &&
        previous !== document.body &&
        document.documentElement.contains(previous) &&
        typeof previous.focus === 'function'
      ) {
        previous.focus();
      }
    }

    function close(reason) {
      var task = pending;
      var cancelled =
        reason === 'cancelled' || !!(reason && reason.fromBack);
      if (overlay) {
        overlay.remove();
        overlay = null;
      }
      pending = null;
      mobileOverlay.dismiss('session-delete-confirm');
      focusPrevious();
      if (cancelled && task) {
        mobileLiveRegion.announce(
          'Session “' + task.label + '” kept.',
          'polite',
        );
      }
    }

    function accept() {
      var task = pending;
      close('accepted');
      if (task) task.onAccept();
    }

    function request(thread, onAccept, parent) {
      if (!thread) return;
      close();
      restoreFocus = document.activeElement;
      var label = thread.title || 'New thread';
      pending = { label: label, onAccept: onAccept };

      overlay = document.createElement('div');
      overlay.className = 'fb-session-close-confirm';
      overlay.setAttribute('role', 'presentation');

      var dialog = document.createElement('section');
      dialog.className = 'fb-session-close-dialog';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', 'fb-session-delete-title');
      dialog.setAttribute('aria-describedby', 'fb-session-delete-copy');

      var heading = document.createElement('h2');
      heading.id = 'fb-session-delete-title';
      heading.className = 'fb-session-close-title';
      heading.textContent = 'Delete session?';
      dialog.appendChild(heading);

      var copy = document.createElement('p');
      copy.id = 'fb-session-delete-copy';
      copy.className = 'fb-session-close-copy';
      copy.textContent =
        'Delete “' +
        label +
        '”? This permanently removes the session and its history. This cannot be undone.';
      dialog.appendChild(copy);

      var announcement = document.createElement('p');
      announcement.className = 'fb-session-close-announcement';
      announcement.setAttribute('role', 'status');
      announcement.setAttribute('aria-live', 'assertive');
      announcement.setAttribute('aria-atomic', 'true');
      announcement.textContent =
        'Confirmation required for “' +
        label +
        '”. Choose Yes to delete session or No to keep it.';
      dialog.appendChild(announcement);

      var actions = document.createElement('div');
      actions.className = 'fb-session-close-actions';
      var no = document.createElement('button');
      no.type = 'button';
      no.className = 'fb-session-close-no';
      no.textContent = 'No';
      no.addEventListener('click', function () {
        close('cancelled');
      });
      var yes = document.createElement('button');
      yes.type = 'button';
      yes.className = 'fb-session-close-yes';
      yes.textContent = 'Yes';
      yes.addEventListener('click', accept);
      actions.appendChild(no);
      actions.appendChild(yes);
      dialog.appendChild(actions);
      overlay.appendChild(dialog);
      overlay.addEventListener('click', function (event) {
        if (event.target === overlay) close('cancelled');
      });
      overlay.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close('cancelled');
        }
      });
      document.body.appendChild(overlay);
      mobileOverlay.open(
        'session-delete-confirm',
        close,
        parent ? { parent: parent } : null,
      );
      no.focus();
    }

    return { request: request };
  })();

  // Programmatic native close clicks bubble through the injected title-menu
  // capture handler. Suppress that one synthetic activation so closing a
  // session cannot reopen the thread menu underneath the confirmation.
  var suppressMobileTabActivation = false;
  function clickNativeTabClose(tab) {
    var button = tab && tab.querySelector('.tab-close');
    if (!button) return false;
    suppressMobileTabActivation = true;
    try {
      button.click();
      return true;
    } finally {
      suppressMobileTabActivation = false;
    }
  }

  function clickNativeTabSelect(tab) {
    var button = tab && tab.querySelector('.tab-select');
    if (!button) return false;
    suppressMobileTabActivation = true;
    try {
      button.click();
      return true;
    } finally {
      suppressMobileTabActivation = false;
    }
  }

  // Re-resolve a session tab by its thread id from the CURRENT tabbar.
  // React can replace tab nodes while the session menu is open (streaming
  // status updates), leaving the row's captured element detached — clicking
  // a detached .tab-select no-ops because it never reaches the app's root
  // event delegation. Always click the live node when it exists.
  function liveTabById(id) {
    if (!id) return null;
    var tabs = document.querySelectorAll(
      '.tabbar:not(.threadbar) .tab:not(.home)',
    );
    for (var i = 0; i < tabs.length; i++) {
      var s = tabs[i].querySelector('.tab-select');
      if (s && (s.id === id || s.id === 'thread-tab-' + id)) return tabs[i];
    }
    return null;
  }

  function isCloseConfirmTarget(target) {
    return !!(
      target &&
      target.closest &&
      target.closest('.fb-session-close-confirm')
    );
  }

  function patchViewport() {
    var meta = document.querySelector('meta[name="viewport"]');
    // Keep zoom unlocked: locking it (user-scalable=no / maximum-scale=1) can
    // trap a remembered zoom level on the phone, and it hurts accessibility.
    var content = 'width=device-width, initial-scale=1, viewport-fit=cover';
    if (meta) {
      meta.setAttribute('content', content);
    } else {
      meta = document.createElement('meta');
      meta.name = 'viewport';
      meta.content = content;
      document.head.appendChild(meta);
    }
  }

  var viewportHeightBound = false;
  function trackViewportHeight() {
    if (viewportHeightBound) return;
    viewportHeightBound = true;
    var root = document.documentElement;
    function set() {
      var h =
        window.visualViewport && window.visualViewport.height
          ? window.visualViewport.height
          : window.innerHeight;
      root.style.setProperty('--fb-vh', h + 'px');
    }
    set();
    window.addEventListener('resize', set, { passive: true });
    window.addEventListener('orientationchange', set, { passive: true });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', set, { passive: true });
    }
  }

  function collapseExplorerForTouch() {
    if (!window.matchMedia(MOBILE).matches) return;
    // Do not click through the app's explorer while its workspace is still
    // booting. Once the shell exists, use a short bounded retry window to
    // collapse the desktop-open drawer without creating a long-lived timer.
    waitForEl('.app', function () {
      var attempts = 0;
      var timer = setInterval(function () {
        if (!window.matchMedia(MOBILE).matches || !document.body) {
          clearInterval(timer);
          return;
        }
        var rememberOpen = false;
        try {
          var tid = activeThreadId();
          rememberOpen = threadStateHas(PANEL_KEY, tid);
        } catch (e) {}
        var open = document.querySelectorAll('.explorer:not(.collapsed)');
        if (open.length === 0 || rememberOpen) {
          clearInterval(timer);
          return;
        }
        open.forEach(function (el) {
          var toggle = el.querySelector('.explorer-toggle');
          if (toggle) toggle.click();
        });
        if (++attempts >= 8) clearInterval(timer);
      }, 200);
    });
  }

  // Shared swipe-down-to-close for injected popovers (thread menu, session
  // menu): dragging down translates the element live and fades it out;
  // releasing past ~60px animates it away (calling onClose), otherwise it
  // snaps back. Uses transitions so the exit matches the open animation.
  function attachSwipeDownClose(el, onClose) {
    var startY = null;
    var startX = null;
    var dragging = false;
    function reset() {
      startY = null;
      startX = null;
      dragging = false;
    }
    el.addEventListener(
      'touchstart',
      function (ev) {
        // A downward gesture inside a scrolled menu should scroll back up,
        // not dismiss the menu. Swipe-to-close is available at the top edge.
        if (el.scrollHeight > el.clientHeight && el.scrollTop > 0) {
          reset();
          return;
        }
        var t = ev.touches[0];
        startY = t.clientY;
        startX = t.clientX;
        dragging = false;
      },
      { passive: true },
    );
    el.addEventListener(
      'touchmove',
      function (ev) {
        if (startY == null) return;
        var t = ev.touches[0];
        var dy = t.clientY - startY;
        var dx = t.clientX - startX;
        if (!dragging && Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) {
          dragging = true;
        }
        if (dragging && dy > 0) {
          ev.preventDefault();
          el.style.transform = 'translateY(' + dy + 'px)';
          el.style.opacity = String(Math.max(0, 1 - dy / 200));
        }
      },
      { passive: false },
    );
    el.addEventListener('touchend', function () {
      var dy =
        parseFloat((el.style.transform || '').replace(/[^0-9.-]/g, '')) || 0;
      if (!dragging) {
        reset();
        return;
      }
      el.style.transform = '';
      el.style.opacity = '';
      reset();
      if (dy <= 60) return; // snap back
      el.style.transition = 'transform 0.12s ease, opacity 0.12s ease';
      el.style.transform = 'translateY(120px)';
      el.style.opacity = '0';
      var done = function () {
        onClose();
      };
      el.addEventListener('transitionend', done, { once: true });
      setTimeout(done, 200); // safety net
    });
  }

  // Model picker as a full-screen sheet on phones (see mobile-ui.css). The
  // app's menu has no close affordance of its own and a full-screen sheet has
  // no "outside" to tap, so inject a close button while it's open. The app
  // closes the menu on any mousedown outside the selector, and our button
  // lives in <body> — so it closes natively; an Escape keydown is dispatched
  // as a fallback. Self-gating on the narrow viewport, so rotation is handled.
  var modelSheetBound = false;
  function modelSheet() {
    if (modelSheetBound) return;
    modelSheetBound = true;
    waitForEl('body', function () {
      var closeBtn = null;
      var availabilitySummary = null;
      var availabilityObserver = null;
      var availabilityObservedMenu = null;
      var availabilityRefreshTimer = null;
      var availabilityPollTimer = null;
      var availabilityPolledMenu = null;
      var sessionUsage = null;
      var sessionUsageRequest = null;
      var sessionUsageMenu = null;
      function modelSessionAvailability(option) {
        var badges = Array.prototype.slice.call(
          option.querySelectorAll('.model-badge'),
        );
        var badgeText = badges
          .map(function (badge) {
            return badge.textContent.trim();
          })
          .join(' · ');
        var ratio = badgeText.match(
          /(\d+)\s*\/\s*(\d+)\s+tabs?\s+in\s+use/i,
        );
        var bucketMatch = badgeText.match(/\b(Premium|Unlimited)\b/i);
        var bucket = bucketMatch ? bucketMatch[1] : 'Sessions';
        if (ratio) {
          var used = Number(ratio[1]);
          var limit = Number(ratio[2]);
          var available = Math.max(0, limit - used);
          return {
            bucket: bucket,
            available: available,
            text: available > 0 ? available + ' available' : 'At capacity',
            detail: available + ' available · ' + used + '/' + limit + ' used',
            state: available > 0 ? 'available' : 'none',
          };
        }
        var tooltip = option.getAttribute('data-tooltip') || '';
        if (/all \d+ .*tabs? are in use/i.test(tooltip)) {
          return {
            bucket: bucket,
            available: 0,
            text: 'At capacity',
            detail: 'No session slots available',
            state: 'none',
          };
        }
        if (option.disabled || option.getAttribute('aria-disabled') === 'true') {
          return {
            bucket: bucket,
            available: null,
            text: 'Unavailable',
            detail: 'Session availability unavailable',
            state: 'unknown',
          };
        }
        return {
          bucket: bucket,
          available: null,
          text: 'Session count unavailable',
          detail: 'Session availability is not reported',
          state: 'unknown',
        };
      }
      function resetLabelFromText(text) {
        var match = String(text || '').match(
          /\bresets?\s+(.+?)(?:\.|$)/i,
        );
        return match ? 'Resets ' + match[1].trim() : '';
      }
      function modelSessionResetLabel(option, bucket) {
        var ownReset = resetLabelFromText(option.getAttribute('data-tooltip'));
        if (ownReset) return ownReset;
        var context = document.querySelector('.composer .context-quota');
        var contextTooltip = context
          ? context.getAttribute('data-tooltip') || ''
          : '';
        var contextReset = resetLabelFromText(contextTooltip);
        if (!contextReset) return '';
        if (
          (bucket === 'Premium' &&
            /shared across all premium models/i.test(contextTooltip)) ||
          (bucket === 'Unlimited' &&
            /shared across all available free models/i.test(contextTooltip)) ||
          option.classList.contains('active')
        ) {
          return contextReset;
        }
        return '';
      }
      function normalizeModelKey(value) {
        return String(value || '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '');
      }
      function projectName(projectPath) {
        return String(projectPath || '')
          .split(/[\\/]/)
          .filter(Boolean)
          .pop() || '';
      }
      function addModelAlias(aliases, id, label) {
        var idKey = normalizeModelKey(id);
        var labelText = String(label || '').trim();
        if (idKey && labelText) aliases[idKey] = labelText;
      }
      function visibleModelTitle(option) {
        return (option && option.getAttribute('title')) || 'Model';
      }
      function activeDomSessionRecord() {
        var tab = document.querySelector(
          '.tabbar:not(.threadbar) .tab.active:not(.home)',
        );
        var title = tab && tab.querySelector('.tab-title');
        var model = document.querySelector('.composer .agent-model');
        var modelText = model && model.textContent.trim();
        if (!tab || !title || !modelText) return null;
        var select = tab.querySelector('.tab-select');
        return {
          id: select && select.id ? select.id.replace(/^thread-tab-/, '') : '',
          title: title.textContent.trim() || 'Current session',
          modelId: modelText,
          modelLabel: modelText,
          projectPath: '',
        };
      }
      function parseSessionUsage(data) {
        var aliases = {};
        var records = [];
        var open = {};
        Array.prototype.slice
          .call(
            document.querySelectorAll(
              '.tabbar:not(.threadbar) .tab:not(.home)',
            ),
          )
          .forEach(function (tab) {
            var select = tab.querySelector('.tab-select');
            if (!select || !select.id) return;
            open[select.id.replace(/^thread-tab-/, '')] = true;
          });
        ((data && data.projects) || []).forEach(function (project) {
          var freebuff = project && project.freebuff;
          (freebuff && freebuff.models ? freebuff.models : []).forEach(
            function (model) {
              addModelAlias(aliases, model && model.id, model && (model.displayName || model.label));
            },
          );
          var active =
            (freebuff && freebuff.activeSessionsByThread) ||
            project.activeSessionsByThread ||
            {};
          var activeIds = Object.keys(active);
          var holders = {};
          var holderCount = 0;
          ['premium', 'unlimited'].forEach(function (tier) {
            var slot = freebuff && freebuff.sessionSlots
              ? freebuff.sessionSlots[tier]
              : null;
            (slot && Array.isArray(slot.holders) ? slot.holders : []).forEach(
              function (id) {
                holders[id] = true;
                holderCount += 1;
              },
            );
          });
          var hasUsageMetadata = activeIds.length > 0 || holderCount > 0;
          (project && project.threads ? project.threads : []).forEach(
            function (thread) {
              if (!thread || !thread.id || !open[thread.id]) return;
              var activeSession = active[thread.id];
              if (hasUsageMetadata && !activeSession && !holders[thread.id]) {
                return;
              }
              var modelId =
                (activeSession && activeSession.model) ||
                (!hasUsageMetadata ? thread.model : '') ||
                thread.model ||
                '';
              if (!modelId) return;
              var modelLabel = aliases[normalizeModelKey(modelId)] || modelId;
              records.push({
                id: thread.id,
                title: thread.title || 'Session',
                modelId: modelId,
                modelLabel: modelLabel,
                projectPath: project.path || project.projectPath || '',
              });
            },
          );
        });
        var domRecord = activeDomSessionRecord();
        if (domRecord) records.push(domRecord);
        var unique = {};
        records = records.filter(function (record) {
          var key =
            (record.id || record.title) + ':' + normalizeModelKey(record.modelLabel || record.modelId);
          if (unique[key]) return false;
          unique[key] = true;
          return true;
        });
        return { loaded: true, records: records, aliases: aliases, checkedAt: Date.now() };
      }
      function refreshSessionUsage(menu) {
        if (!menu || !document.documentElement.contains(menu)) return;
        var now = Date.now();
        if (
          sessionUsageMenu === menu &&
          sessionUsage &&
          now - sessionUsage.checkedAt < 5000
        ) {
          return;
        }
        if (sessionUsageRequest && sessionUsageMenu === menu) return;
        sessionUsageMenu = menu;
        var request = fetch('/api/projects', {
          headers: { Accept: 'application/json' },
        })
          .then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
          })
          .then(function (data) {
            if (sessionUsageRequest !== request || sessionUsageMenu !== menu) {
              return;
            }
            sessionUsage = parseSessionUsage(data);
            if (
              document.documentElement.contains(menu) &&
              window.matchMedia('(max-width: 700px)').matches
            ) {
              syncModelAvailability(menu);
            }
          })
          .catch(function () {
            if (sessionUsageRequest !== request || sessionUsageMenu !== menu) {
              return;
            }
            sessionUsage = {
              loaded: false,
              records: [],
              aliases: {},
              checkedAt: Date.now(),
            };
          });
        sessionUsageRequest = request;
        request.then(function () {
          if (sessionUsageRequest === request) sessionUsageRequest = null;
        });
      }
      function modelSessionUserRecords(option) {
        var titleKey = normalizeModelKey(visibleModelTitle(option));
        var records = sessionUsage ? sessionUsage.records : [];
        var matches = [];
        records.forEach(function (record) {
          var modelKeys = [record.modelId, record.modelLabel].map(normalizeModelKey);
          if (!titleKey || modelKeys.indexOf(titleKey) < 0) return;
          var name = String(record.title || 'Session').trim();
          var duplicateTitle = records.some(function (other) {
            return (
              other !== record &&
              String(other.title || '').trim() === name &&
              other.projectPath !== record.projectPath
            );
          });
          if (duplicateTitle) {
            var project = projectName(record.projectPath);
            if (project) name += ' (' + project + ')';
          }
          if (
            !name ||
            matches.some(function (match) {
              return match.name === name;
            })
          ) {
            return;
          }
          matches.push({ record: record, name: name });
        });
        return matches;
      }
      function findOpenSessionTab(record) {
        if (!record || !record.id) return null;
        var expectedId = 'thread-tab-' + record.id;
        var tabs = document.querySelectorAll(
          '.tabbar:not(.threadbar) .tab:not(.home)',
        );
        for (var i = 0; i < tabs.length; i++) {
          var select = tabs[i].querySelector('.tab-select');
          if (select && (select.id === expectedId || select.id === record.id)) {
            return tabs[i];
          }
        }
        return null;
      }
      function selectOpenSession(record, displayName) {
        var tab = findOpenSessionTab(record);
        if (!tab || !clickNativeTabSelect(tab)) return false;
        mobileLiveRegion.announce(
          'Selected session: “' + displayName + '”.',
          'polite',
        );
        closeModelSheet();
        return true;
      }
      function isInjectedAvailabilityNode(node) {
        var element =
          node && node.nodeType === 1
            ? node
            : node && node.parentElement
              ? node.parentElement
              : null;
        return !!(
          element &&
          element.closest &&
          element.closest(
            '.fb-model-session-summary, .fb-model-session-count, .fb-model-session-reset, .fb-model-session-users',
          )
        );
      }
      function scheduleAvailabilityRefresh(menu) {
        if (
          availabilityRefreshTimer ||
          !menu ||
          !document.documentElement.contains(menu)
        ) {
          return;
        }
        availabilityRefreshTimer = window.setTimeout(function () {
          availabilityRefreshTimer = null;
          if (
            document.documentElement.contains(menu) &&
            window.matchMedia('(max-width: 700px)').matches
          ) {
            syncModelAvailability(menu);
          }
        }, 50);
      }
      function observeModelAvailability(menu) {
        if (availabilityObservedMenu === menu && availabilityObserver) return;
        if (availabilityObserver) availabilityObserver.disconnect();
        availabilityObserver = null;
        availabilityObservedMenu = menu;
        if (typeof window.MutationObserver !== 'function' || !menu) return;
        availabilityObserver = new MutationObserver(function (records) {
          if (
            records.some(function (record) {
              return ![
                record.target,
              ]
                .concat(Array.prototype.slice.call(record.addedNodes || []))
                .concat(Array.prototype.slice.call(record.removedNodes || []))
                .every(isInjectedAvailabilityNode);
            })
          ) {
            scheduleAvailabilityRefresh(menu);
          }
        });
        availabilityObserver.observe(menu, {
          attributes: true,
          attributeFilter: ['class', 'disabled', 'aria-disabled', 'data-tooltip'],
          childList: true,
          characterData: true,
          subtree: true,
        });
      }
      function stopAvailabilityPolling() {
        if (availabilityRefreshTimer) {
          window.clearTimeout(availabilityRefreshTimer);
          availabilityRefreshTimer = null;
        }
        if (availabilityPollTimer) {
          window.clearInterval(availabilityPollTimer);
          availabilityPollTimer = null;
        }
        availabilityPolledMenu = null;
      }
      function startAvailabilityPolling(menu) {
        if (!menu) return;
        if (availabilityPollTimer && availabilityPolledMenu === menu) return;
        if (availabilityPollTimer) window.clearInterval(availabilityPollTimer);
        availabilityPolledMenu = menu;
        availabilityPollTimer = window.setInterval(function () {
          if (
            !document.documentElement.contains(menu) ||
            !window.matchMedia('(max-width: 700px)').matches
          ) {
            stopAvailabilityPolling();
            return;
          }
          syncModelAvailability(menu);
        }, 1000);
      }
      function clearModelAvailability(menu) {
        stopAvailabilityPolling();
        if (availabilityObserver) availabilityObserver.disconnect();
        availabilityObserver = null;
        availabilityObservedMenu = null;
        var scope = menu || document;
        Array.prototype.slice
          .call(
            scope.querySelectorAll(
              '.fb-model-session-summary, .fb-model-session-count, .fb-model-session-reset, .fb-model-session-users',
            ),
          )
          .forEach(function (element) {
            element.remove();
          });
        Array.prototype.slice
          .call(scope.querySelectorAll('.freebuff-model-option'))
          .forEach(function (option) {
            var injectedLabel = option.getAttribute(
              'data-fb-model-session-aria',
            );
            var baseLabel = option.getAttribute(
              'data-fb-model-session-aria-base',
            );
            if (injectedLabel !== null) {
              if (baseLabel) option.setAttribute('aria-label', baseLabel);
              else option.removeAttribute('aria-label');
              option.removeAttribute('data-fb-model-session-aria');
              option.removeAttribute('data-fb-model-session-aria-base');
            }
          });
        availabilitySummary = null;
        sessionUsage = null;
        sessionUsageMenu = null;
        sessionUsageRequest = null;
      }
      function syncModelAvailability(menu) {
        if (!menu) return;
        refreshSessionUsage(menu);
        observeModelAvailability(menu);
        startAvailabilityPolling(menu);
        var options = Array.prototype.slice.call(
          menu.querySelectorAll('.freebuff-model-option'),
        );
        if (!options.length) return;
        if (!availabilitySummary || !menu.contains(availabilitySummary)) {
          availabilitySummary = document.createElement('div');
          availabilitySummary.className = 'fb-model-session-summary';
          availabilitySummary.setAttribute('role', 'status');
          availabilitySummary.setAttribute('aria-live', 'polite');
          availabilitySummary.setAttribute('aria-atomic', 'true');
          menu.insertBefore(availabilitySummary, menu.firstChild);
        }
        var buckets = {};
        options.forEach(function (option) {
          var availability = modelSessionAvailability(option);
          var resetLabel = modelSessionResetLabel(option, availability.bucket);
          var userRecords = modelSessionUserRecords(option);
          var usersText = userRecords.length
            ? 'Used by: ' +
              userRecords
                .map(function (match) {
                  return match.name;
                })
                .join(', ')
            : 'Session names unavailable';
          var title = option.querySelector('.agent-option-title');
          if (title) {
            var count = title.querySelector('.fb-model-session-count');
            if (!count) {
              count = document.createElement('span');
              count.className = 'fb-model-session-count';
              title.appendChild(count);
            }
            var countClass =
              'fb-model-session-count ' + availability.state;
            var countAriaLabel =
              'Session availability: ' + availability.text + '. ' + usersText;
            if (count.className !== countClass) count.className = countClass;
            if (count.textContent !== availability.text) {
              count.textContent = availability.text;
            }
            var countDetail = availability.detail + ' · ' + usersText;
            if (count.title !== countDetail) {
              count.title = countDetail;
            }
            if (count.getAttribute('aria-label') !== countAriaLabel) {
              count.setAttribute('aria-label', countAriaLabel);
            }
          }
          var body = option.querySelector('.agent-option-body');
          if (body) {
            var reset = body.querySelector('.fb-model-session-reset');
            if (!reset) {
              reset = document.createElement('span');
              reset.className = 'fb-model-session-reset';
              body.appendChild(reset);
            }
            var resetText = resetLabel || 'Reset time unavailable';
            var resetClass =
              'fb-model-session-reset' + (resetLabel ? '' : ' unknown');
            if (reset.className !== resetClass) reset.className = resetClass;
            if (reset.textContent !== resetText) reset.textContent = resetText;
            reset.title = resetLabel
              ? resetLabel
              : 'The app did not report a reset time for this model';
            reset.setAttribute('aria-label', resetText);
            var users = option.nextElementSibling;
            if (
              !users ||
              !users.matches('.fb-model-session-users') ||
              users.getAttribute('data-fb-model-session-for') !== visibleModelTitle(option)
            ) {
              users = document.createElement('div');
              users.className = 'fb-model-session-users';
              option.parentNode.insertBefore(users, option.nextSibling);
            }
            users.setAttribute('data-fb-model-session-for', visibleModelTitle(option));
            var usersClass =
              'fb-model-session-users' +
              (usersText.indexOf('Used by: ') === 0 ? '' : ' unknown');
            if (users.className !== usersClass) users.className = usersClass;
            if (users.getAttribute('data-fb-model-session-text') !== usersText) {
              users.textContent = '';
              if (!userRecords.length) {
                users.textContent = usersText;
              } else {
                var prefix = document.createElement('span');
                prefix.className = 'fb-model-session-user-prefix';
                prefix.textContent = 'Used by: ';
                users.appendChild(prefix);
                userRecords.forEach(function (match, index) {
                  if (index > 0) users.appendChild(document.createTextNode(', '));
                  var user = document.createElement('span');
                  user.className = 'fb-model-session-user';
                  user.setAttribute('role', 'button');
                  user.setAttribute('tabindex', '0');
                  user.setAttribute(
                    'aria-label',
                    'Switch to session “' + match.name + '”',
                  );
                  user.title = 'Switch to ' + match.name;
                  user.textContent = match.name;
                  function activate(event) {
                    event.preventDefault();
                    event.stopPropagation();
                    selectOpenSession(match.record, match.name);
                  }
                  user.addEventListener('click', activate);
                  user.addEventListener('keydown', function (event) {
                    if (event.key === 'Enter' || event.key === ' ') activate(event);
                  });
                  users.appendChild(user);
                });
              }
              users.setAttribute('data-fb-model-session-text', usersText);
            }
            users.title = usersText;
            users.setAttribute('aria-label', usersText);
          }
          var currentAria = option.getAttribute('aria-label') || '';
          var previousInjectedAria = option.getAttribute(
            'data-fb-model-session-aria',
          );
          var hasBaseAria = option.hasAttribute(
            'data-fb-model-session-aria-base',
          );
          var baseAria = hasBaseAria
            ? option.getAttribute('data-fb-model-session-aria-base') || ''
            : currentAria;
          if (!hasBaseAria || currentAria !== previousInjectedAria) {
            baseAria = currentAria;
            option.setAttribute('data-fb-model-session-aria-base', baseAria);
          }
          var nextAria = [
            baseAria || option.getAttribute('title') || 'Model',
            availability.text,
            usersText,
            resetLabel || 'Reset time unavailable',
          ].join('. ') + '.';
          if (currentAria !== nextAria) option.setAttribute('aria-label', nextAria);
          option.setAttribute('data-fb-model-session-aria', nextAria);
          if (availability.available !== null && !buckets[availability.bucket]) {
            buckets[availability.bucket] = availability;
          }
        });
        var bucketText = Object.keys(buckets).map(function (bucket) {
          return bucket + ': ' + buckets[bucket].text;
        });
        var summaryText = bucketText.length
          ? 'Session availability · ' + bucketText.join(' · ')
          : 'Session availability is not reported for these models';
        if (availabilitySummary.textContent !== summaryText) {
          availabilitySummary.textContent = summaryText;
        }
      }
      function closeModelSheet() {
        var menu = document.querySelector('.composer-context .agent-menu');
        if (menu) {
          // Close native React state directly. Do not click .agent-trigger:
          // the sheet's outside mousedown may already have queued its close,
          // and toggling the trigger in same gesture can reopen the picker.
          menu.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'Escape',
              bubbles: true,
              cancelable: true,
            }),
          );
        }
        mobileOverlay.dismiss('model-sheet');
      }
      watchMobileBody(function () {
        var narrow = window.matchMedia('(max-width: 700px)').matches;
        var menu = document.querySelector('.composer-context .agent-menu');
        if (!menu || !narrow) {
          clearModelAvailability(menu);
          mobileOverlay.dismiss('model-sheet');
          if (closeBtn) {
            closeBtn.remove();
            closeBtn = null;
          }
          return;
        }
        mobileOverlay.open('model-sheet', closeModelSheet, {
          parent: 'context-card',
        });
        syncModelAvailability(menu);
        if (closeBtn) return;
        closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'fb-model-sheet-close';
        closeBtn.setAttribute('aria-label', 'Close model picker');
        closeBtn.title = 'Close';
        closeBtn.innerHTML =
          '<svg width="18" height="18" viewBox="0 0 16 16" fill="none" ' +
          'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ' +
          'aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
        closeBtn.addEventListener('click', closeModelSheet);
        document.body.appendChild(closeBtn);
      });
    });
  }

  // Codex device auth: keep provider credentials inside the official Codex CLI.
  // This action is injected into every native model menu so Desktop and paired
  // mobile surfaces share one setup path.
  var codexConnectBound = false;
  function codexConnect() {
    if (codexConnectBound) return;
    codexConnectBound = true;
    waitForEl('body', function () {
      var dialog = null;
      var pollTimer = null;
      var pending = false;
      var deviceUrl = 'https://auth.openai.com/codex/device/';
      function openExternal(url) {
        if (window.FreebuffNative && window.FreebuffNative.openExternal) {
          try {
            window.FreebuffNative.openExternal(url);
            return;
          } catch (e) {}
        }
        window.open(url, '_blank', 'noopener');
      }
      function stopPolling() {
        if (pollTimer) {
          window.clearInterval(pollTimer);
          pollTimer = null;
        }
      }
      function close() {
        stopPolling();
        if (pending) {
          pending = false;
          fetch('/api/fb/codex/device/cancel', { method: 'POST' }).catch(function () {});
        }
        if (dialog && dialog.parentNode) dialog.parentNode.removeChild(dialog);
        dialog = null;
        mobileOverlay.dismiss('codex-device-auth');
      }
      function statusMessage(value, error) {
        if (error === 'codex_cli_missing') return 'Install Codex CLI on Desktop, then retry.';
        if (error === 'codex_login_timeout') return 'Device code expired. Start again.';
        return {
          starting: 'Preparing device code…',
          waiting: 'Open device page and enter code.',
          connected: 'Codex connected. Refreshing models…',
          failed: 'Codex setup failed. Try again.',
          cancelled: 'Codex setup cancelled.',
        }[value] || 'Waiting for approval…';
      }
      function showState(payload, status, retry) {
        if (!dialog) return;
        var statusEl = dialog.querySelector('.fb-codex-status');
        var codeEl = dialog.querySelector('.fb-codex-code');
        var retryEl = dialog.querySelector('.fb-codex-retry');
        if (payload && payload.deviceUrl) {
          deviceUrl = payload.deviceUrl;
          var link = dialog.querySelector('.fb-codex-device-link');
          link.href = deviceUrl;
          link.textContent = deviceUrl;
        }
        if (payload && payload.userCode) codeEl.textContent = payload.userCode;
        statusEl.textContent = status || statusMessage(payload && payload.state, payload && payload.error);
        retryEl.hidden = !retry;
        if (payload && payload.state === 'connected') {
          pending = false;
          stopPolling();
          fetch('/api/projects', { headers: { Accept: 'application/json' } })
            .catch(function () {})
            .then(function () {
              window.dispatchEvent(new Event('fb-codex-connected'));
              window.setTimeout(close, 500);
            });
        }
      }
      function poll() {
        fetch('/api/fb/codex/device/status', { headers: { Accept: 'application/json' } })
          .then(function (response) {
            if (!response.ok) throw new Error('status');
            return response.json();
          })
          .then(function (payload) {
            showState(payload);
            if (payload.state === 'connected' || payload.state === 'failed' || payload.state === 'cancelled') {
              pending = false;
              stopPolling();
              if (payload.state === 'failed') showState(payload, statusMessage(payload.state, payload.error), true);
            }
          })
          .catch(function () {
            showState({}, 'Unable to check Codex status. Retrying…');
          });
      }
      function start() {
        pending = true;
        showState({ state: 'starting' });
        fetch('/api/fb/codex/device/start', { method: 'POST' })
          .then(function (response) {
            return response.json().then(function (payload) {
              if (!response.ok) throw new Error(payload.error || 'codex_login_failed');
              return payload;
            });
          })
          .then(function (payload) {
            showState(payload);
            pollTimer = window.setInterval(poll, 1000);
            poll();
          })
          .catch(function (error) {
            pending = false;
            stopPolling();
            showState({}, error.message === 'codex_cli_missing'
              ? 'Install Codex CLI on Desktop, then retry.'
              : 'Codex setup failed. Try again.', true);
          });
      }
      function openDialog() {
        if (dialog) return;
        var menu = document.querySelector('.agent-menu');
        if (menu) {
          menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        }
        dialog = document.createElement('div');
        dialog.className = 'fb-codex-overlay';
        dialog.innerHTML =
          '<section class="fb-codex-dialog" role="dialog" aria-modal="true" aria-labelledby="fb-codex-title">' +
          '<div class="fb-codex-head"><h2 id="fb-codex-title">Connect Codex</h2><button type="button" class="fb-codex-close" aria-label="Close">×</button></div>' +
          '<p class="fb-codex-copy">Pair Desktop with your OpenAI account using official Codex device auth.</p>' +
          '<a class="fb-codex-device-link" href="https://auth.openai.com/codex/device/" target="_blank" rel="noopener">https://auth.openai.com/codex/device/</a>' +
          '<div class="fb-codex-code-label">Device code</div><code class="fb-codex-code">Preparing…</code>' +
          '<p class="fb-codex-status" role="status" aria-live="polite">Starting…</p>' +
          '<div class="fb-codex-actions"><button type="button" class="fb-codex-open">Open device page</button><button type="button" class="fb-codex-copy-code">Copy code</button><button type="button" class="fb-codex-retry" hidden>Retry</button></div>' +
          '</section>';
        dialog.querySelector('.fb-codex-close').addEventListener('click', close);
        dialog.querySelector('.fb-codex-open').addEventListener('click', function () { openExternal(deviceUrl); });
        dialog.querySelector('.fb-codex-copy-code').addEventListener('click', function () {
          var value = dialog.querySelector('.fb-codex-code').textContent;
          if (navigator.clipboard && value !== 'Preparing…') navigator.clipboard.writeText(value).catch(function () {});
        });
        dialog.querySelector('.fb-codex-retry').addEventListener('click', function () {
          dialog.querySelector('.fb-codex-retry').hidden = true;
          start();
        });
        dialog.addEventListener('click', function (event) { if (event.target === dialog) close(); });
        document.body.appendChild(dialog);
        mobileOverlay.open('codex-device-auth', close);
        start();
      }
      function syncMenus() {
        document.querySelectorAll('.agent-menu').forEach(function (menu) {
          if (!menu.querySelector('.fb-codex-connect')) {
            var button = document.createElement('button');
            button.type = 'button';
            button.className = 'fb-codex-connect';
            button.setAttribute('role', 'button');
            button.textContent = 'Connect Codex';
            button.addEventListener('mousedown', function (event) { event.stopPropagation(); });
            button.addEventListener('click', function (event) {
              event.preventDefault();
              event.stopPropagation();
              openDialog();
            });
            menu.appendChild(button);
          }
        });
      }
      new MutationObserver(syncMenus).observe(document.body, { childList: true, subtree: true });
      syncMenus();
    });
  }

  // Tab-title menu: on mobile the header shows the active thread as a title,
  // and the tab's own actions (rename / pop out / close) are hidden. Tapping
  // the title opens a small menu that reuses those exact app actions: rename
  // dispatches a dblclick on the tab's select (React's rename trigger), pop
  // out and close click the tab's own .tab-popout / .tab-close buttons.
  var tabMenuBound = false;
  function tabTitleMenu() {
    if (tabMenuBound) return;
    tabMenuBound = true;
    if (!window.matchMedia(MOBILE).matches) return;
    waitForEl('.tabbar:not(.threadbar)', function () {
      var tabbar = document.querySelector('.tabbar:not(.threadbar)');
      if (!tabbar) return;

      var menu = null;
      var openedTab = null;
      function activeTab() {
        return tabbar.querySelector('.tab.active');
      }
      function close() {
        if (menu) {
          menu.remove();
          menu = null;
          openedTab = null;
        }
        mobileOverlay.dismiss('thread-menu');
      }
      function open() {
        close();
        var tab = activeTab();
        if (!tab || tab.classList.contains('home')) return;
        openedTab = tab;
        var title =
          (tab.querySelector('.tab-title') || {}).textContent || 'Thread';
        menu = document.createElement('div');
        menu.className = 'fb-tab-menu';
        menu.setAttribute('role', 'menu');
        var head = document.createElement('div');
        head.className = 'fb-tab-menu-title';
        head.textContent = title;
        head.setAttribute('role', 'presentation');
        menu.appendChild(head);
        var items = [
          {
            label: 'Rename',
            action: function () {
              var sel = tab.querySelector('.tab-select');
              if (sel) {
                sel.dispatchEvent(
                  new MouseEvent('dblclick', { bubbles: true, cancelable: true }),
                );
              }
            },
          },
          {
            label: 'Move to new window',
            action: function () {
              var b = tab.querySelector('.tab-popout');
              if (b) b.click();
            },
          },
          {
            // Accessibility toggle: larger chat text, on demand, persisted.
            label: 'Larger chat text',
            toggle: true,
            checked: function () {
              return root.classList.contains('fb-text-large');
            },
            action: function () {
              var on = root.classList.toggle('fb-text-large');
              try {
                if (on) localStorage.setItem(TEXT_KEY, '1');
                else localStorage.removeItem(TEXT_KEY);
              } catch (e) {}
            },
          },
          {
            // The report/feedback pill is hidden on mobile (moved here);
            // clicking reopens the app's own feedback modal via its button.
            label: 'Report an issue',
            action: function () {
              var fb = document.querySelector('.global-feedback');
              if (fb) fb.click();
            },
          },
          {
            label: 'Close',
            danger: true,
            confirm: true,
            action: function () {
              closeSessionConfirm.request(
                tab,
                function () {
                  var closed = clickNativeTabClose(tab);
                  close();
                  return closed;
                },
                'thread-menu',
              );
            },
          },
        ];
        items.forEach(function (it) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'fb-tab-menu-item' + (it.danger ? ' danger' : '');
          if (it.toggle) {
            b.setAttribute('role', 'menuitemcheckbox');
            b.setAttribute('aria-checked', String(!!it.checked()));
          } else {
            b.setAttribute('role', 'menuitem');
          }
          b.textContent = it.label;
          if (it.toggle) {
            var check = document.createElement('span');
            check.className = 'fb-tab-menu-check';
            check.setAttribute('aria-hidden', 'true');
            check.textContent = '\u2713';
            b.appendChild(check);
          }
          b.addEventListener('click', function (ev) {
            ev.stopPropagation();
            it.action();
            if (!it.confirm) close();
          });
          menu.appendChild(b);
        });
        document.body.appendChild(menu);
        attachSwipeDownClose(menu, close);
        mobileOverlay.open('thread-menu', close);
      }

      // Capture phase so the toggle runs before the app's own click handling.
      document.addEventListener(
        'click',
        function (ev) {
          if (!window.matchMedia(MOBILE).matches) return;
          if (isCloseConfirmTarget(ev.target)) return;
          if (suppressMobileTabActivation) return;
          var tab = activeTab();
          if (tab && tab.contains(ev.target)) {
            if (menu) close();
            else open();
            return;
          }
          if (menu && !menu.contains(ev.target)) close();
        },
        true,
      );
      document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') close();
      });
      window.addEventListener('resize', close);
      window.addEventListener(
        'scroll',
        function (ev) {
          // Do not close when the user scrolls the menu itself (especially
          // the Recent session list); only external page scrolling dismisses.
          if (menu && menu.contains(ev.target)) return;
          close();
        },
        true,
      );

      // React re-renders the header on tab/state changes — keep the menu in
      // sync (refresh the title, or close if the tab changed / explorer drawer
      // opened).
      new MutationObserver(function () {
        if (!menu) return;
        var tab = activeTab();
        if (!tab || openedTab !== tab) {
          close();
          return;
        }
        var head = menu.querySelector('.fb-tab-menu-title');
        var title = (tab.querySelector('.tab-title') || {}).textContent;
        if (head && title) head.textContent = title;
        if (document.querySelector('.explorer:not(.collapsed)')) close();
      }).observe(tabbar, { childList: true, subtree: true });
    });
  }

  // Open a closed session as a tab via the app's home catalog — the only
  // native path (the store is module-private). Go home, make sure the right
  // project is selected (matching the full path in data-tooltip), then click
  // the matching .home-thread row (its onClick runs the app's own open-thread
  // action → new tab + loadThread). Shared by the session menu's Recent
  // section and the home-page Thread history sheet.
  function openThreadViaHomeCatalog(th) {
    // Fast native path: the tailnet proxy patches the bundle to expose the
    // app's own open-thread action (Rq) on window.__fbOpenThread, so a
    // closed session opens as a tab directly. Prefer it: the catalog
    // fallback below only renders when the home thread is still empty, and
    // the home thread usually holds a conversation.
    if (
      window.__fbOpenThread &&
      typeof window.__fbOpenThread === 'function' &&
      th &&
      th.id
    ) {
      try {
        window.__fbOpenThread({
          id: th.id,
          projectPath: th.projectPath || '',
        });
        return;
      } catch (e) {
        // fall through to the catalog path
      }
    }
    var home = document.querySelector('.tab.home');
    if (home) home.click();
    var attempts = 0;
    var timer = setInterval(function () {
      if (++attempts > 60) {
        clearInterval(timer);
        return; // ~3s cap
      }
      // Clear any leftover catalog search/filter so the row can match.
      var inp = document.querySelector('.home-thread-search input');
      if (inp && inp.value) {
        var setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value',
        ).set;
        setter.call(inp, '');
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      }
      var activeTab = document.querySelector(
        '#home-catalog-tab-active:not([aria-selected="true"])',
      );
      if (activeTab) activeTab.click();
      var rows = document.querySelectorAll('.home-thread');
      if (!rows.length) return; // catalog not rendered yet
      var sel = document.querySelector('.home-project.selected');
      if (!sel || sel.getAttribute('data-tooltip') !== th.projectPath) {
        var pr = Array.prototype.slice
          .call(document.querySelectorAll('.home-project'))
          .find(function (b) {
            return b.getAttribute('data-tooltip') === th.projectPath;
          });
        if (pr) {
          pr.click(); // switching project re-renders — keep polling
          return;
        }
      }
      // Match the row by title; if several rows share the title, prefer
      // the one whose relative age is closest to the thread's own.
      function ageFromText(txt) {
        if (!txt) return null;
        txt = txt.trim();
        if (txt === 'now') return 0;
        var m = txt.match(/^(\d+)m$/);
        if (m) return +m[1] * 60000;
        var h = txt.match(/^(\d+)h$/);
        if (h) return +h[1] * 3600000;
        var d = txt.match(/^(\d+)d$/);
        if (d) return +d[1] * 86400000;
        return null; // date text — can't compare reliably
      }
      var expected =
        Date.now() - (th.lastPromptAt || th.updatedAt || Date.now());
      var matches = Array.prototype.slice.call(rows).filter(function (r) {
        var t = r.querySelector('.home-thread-title');
        return t && t.textContent.trim() === th.title;
      });
      if (!matches.length) return; // still loading — keep polling
      var target = matches[0];
      if (matches.length > 1) {
        matches.sort(function (a, b) {
          var aa = ageFromText(
            (a.querySelector('.home-thread-time') || {}).textContent,
          );
          var ba = ageFromText(
            (b.querySelector('.home-thread-time') || {}).textContent,
          );
          if (aa == null && ba == null) return 0;
          if (aa == null) return 1;
          if (ba == null) return -1;
          return Math.abs(aa - expected) - Math.abs(ba - expected);
        });
        target = matches[0];
      }
      clearInterval(timer);
      target.click(); // the app's open-thread action
    }, 50);
  }

  // Session switcher (mobile): the tab strip is hidden on phones (slim
  // header), so switching between open sessions needs a dropdown. A header
  // button opens a menu listing the open session tabs; picking one clicks the
  // app's own .tab-select (native activation). Footer actions reuse the app's
  // .tab-new (new thread) and .tab.home (thread list) buttons.
  var sessionBound = false;
  function sessionSwitcher() {
    if (sessionBound) return;
    sessionBound = true;
    waitForEl('.tabbar:not(.threadbar)', function () {
      var tabbar = document.querySelector('.tabbar:not(.threadbar)');
      if (!tabbar) return;

      var btn = null;
      var menu = null;
      var openedActive = null;
      var openedIds = null;
      var sessionModels = {};
      var sessionModelAliases = {};
      var sessionStatuses = {};
      var sessionStatusPollTimer = null;
      var modelFilter = null;
      var modelFilterEmpty = null;
      var modelFilterValue = 'all';

      function sessionTabs() {
        return Array.prototype.slice.call(
          tabbar.querySelectorAll('.tab:not(.home)'),
        );
      }
      // The switcher must stay reachable even when the only open tab is the
      // home thread (boot-home): the dropdown is the mobile path to Recent
      // sessions and New session. Show it whenever any tab exists, including
      // the home tab.
      function hasAnyTab() {
        return tabbar.querySelectorAll('.tab').length > 0;
      }
      function activeTab() {
        return tabbar.querySelector('.tab.active');
      }
      function titleOf(tab) {
        var el = tab.querySelector('.tab-title');
        return el ? el.textContent.trim() : 'Session';
      }
      // Stable id for a session tab (the app ids the .tab-select buttons),
      // used to detect when sessions open/close/reorder while the menu is up.
      function tabIds() {
        return sessionTabs().map(function (t) {
          var s = t.querySelector('.tab-select');
          return s && s.id ? s.id : t.textContent || '';
        });
      }
      // Thread id of an open tab, from its .tab-select id ("thread-tab-<id>").
      function threadIdOf(tab) {
        var s = tab.querySelector('.tab-select');
        if (!s || !s.id) return '';
        return s.id.indexOf('thread-tab-') === 0 ? s.id.slice(11) : s.id;
      }
      function normalizeSessionModelKey(value) {
        return String(value || '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '');
      }
      function sessionModelValue(value) {
        if (typeof value === 'string') return value.trim();
        if (!value || typeof value !== 'object') return '';
        return String(value.displayName || value.label || value.id || '').trim();
      }
      function sessionStatusValue(value) {
        if (value === true) return 'Running';
        if (value === false) return 'Stopped';
        var raw = '';
        if (typeof value === 'string') {
          raw = value;
        } else if (value && typeof value === 'object') {
          if (value.running === true || value.isRunning === true) return 'Running';
          if (value.running === false || value.isRunning === false) return 'Stopped';
          raw =
            value.turnState ||
            value.status ||
            value.state ||
            value.runState ||
            value.sessionState ||
            value.lastTurnOutcome ||
            '';
        }
        raw = String(raw || '').trim().toLowerCase();
        if (!raw) return '';
        if (
          /not\s+running|stopped|finished|failed|error|complete|completed|idle|paused|cancelled|canceled|success|auto-stopped/.test(
            raw,
          )
        ) {
          return 'Stopped';
        }
        if (/running|streaming|generating|working|queued|pending|resuming|active/.test(raw)) {
          return 'Running';
        }
        return '';
      }
      function sessionStatusFromTab(tab) {
        if (!tab) return '';
        var stateNode = tab.querySelector(
          '[data-turn-state], [data-status], [data-session-status]',
        );
        var explicit = [
          tab.getAttribute('data-turn-state'),
          tab.getAttribute('data-status'),
          tab.getAttribute('data-session-status'),
          stateNode && stateNode.getAttribute('data-turn-state'),
          stateNode && stateNode.getAttribute('data-status'),
          stateNode && stateNode.getAttribute('data-session-status'),
        ];
        for (var i = 0; i < explicit.length; i++) {
          var explicitStatus = sessionStatusValue(explicit[i]);
          if (explicitStatus) return explicitStatus;
        }
        var classes = String(tab.className || '');
        if (/(^|[\s-])(running|streaming|working|generating)(?:$|[\s-])/i.test(classes)) {
          return 'Running';
        }
        if (/(^|[\s-])(stopped|finished|idle|paused)(?:$|[\s-])/i.test(classes)) {
          return 'Stopped';
        }
        if (tab.classList.contains('active')) {
          var stop = document.querySelector('.composer .composer-row .stop');
          if (stop) {
            var style = window.getComputedStyle(stop);
            if (
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              !stop.disabled
            ) {
              return 'Running';
            }
          }
        }
        return '';
      }
      function sessionStatusForThreadId(id) {
        var tabs = sessionTabs();
        for (var i = 0; i < tabs.length; i++) {
          if (threadIdOf(tabs[i]) !== id) continue;
          var domStatus = sessionStatusFromTab(tabs[i]);
          if (domStatus) return domStatus;
          break;
        }
        return (id && sessionStatuses[id]) || 'Stopped';
      }
      function sessionStatusForThread(thread) {
        return (
          sessionStatusValue(thread) ||
          sessionStatusForThreadId(thread && thread.id) ||
          'Stopped'
        );
      }
      function addSessionModelAlias(aliases, id, label) {
        var key = normalizeSessionModelKey(id);
        var text = sessionModelValue(label);
        if (key && text) aliases[key] = text;
      }
      function updateSessionModelMap(data) {
        var next = {};
        var aliases = {};
        var statuses = {};
        ((data && data.projects) || []).forEach(function (project) {
          var freebuff = project && project.freebuff;
          (freebuff && freebuff.models ? freebuff.models : []).forEach(function (model) {
            addSessionModelAlias(
              aliases,
              model && model.id,
              model && (model.displayName || model.label),
            );
          });
          var active =
            (freebuff && freebuff.activeSessionsByThread) ||
            (project && project.activeSessionsByThread) ||
            {};
          (project && project.threads ? project.threads : []).forEach(function (thread) {
            if (!thread || !thread.id) return;
            var activeSession = active[thread.id];
            var status =
              sessionStatusValue(activeSession) || sessionStatusValue(thread);
            if (status) statuses[thread.id] = status;
            var modelId =
              sessionModelValue(activeSession && activeSession.model) ||
              sessionModelValue(thread.model);
            if (!modelId) return;
            next[thread.id] =
              aliases[normalizeSessionModelKey(modelId)] || modelId;
          });
        });
        sessionModels = next;
        sessionModelAliases = aliases;
        sessionStatuses = statuses;
        renderSessionModelLegend();
      }
      function currentComposerModel() {
        var model = document.querySelector('.composer .agent-model');
        return model ? model.textContent.trim() : '';
      }
      function modelLabelForThreadId(id) {
        if (id && sessionModels[id]) return sessionModels[id];
        var active = activeTab();
        if (id && active && threadIdOf(active) === id) {
          return currentComposerModel() || 'Model unavailable';
        }
        return 'Model unavailable';
      }
      function modelLabelForThread(thread) {
        if (!thread) return 'Model unavailable';
        if (sessionModels[thread.id]) return sessionModels[thread.id];
        var modelId = sessionModelValue(thread.model);
        return modelId
          ? sessionModelAliases[normalizeSessionModelKey(modelId)] || modelId
          : 'Model unavailable';
      }
      function makeSessionModelLine(main, modelLabel, sessionId, thread) {
        var line = document.createElement('span');
        line.className = 'fb-session-menu-model-line';
        var model = document.createElement('span');
        model.className =
          'fb-session-menu-model' +
          (modelLabel === 'Model unavailable' ? ' unknown' : '');
        model.textContent = modelLabel;
        model.title = modelLabel;
        model.setAttribute('aria-label', 'Model: ' + modelLabel);
        line.appendChild(model);
        var statusLabel = thread
          ? sessionStatusForThread(thread)
          : sessionStatusForThreadId(sessionId);
        var status = document.createElement('span');
        status.className =
          'fb-session-menu-status ' + statusLabel.toLowerCase();
        status.textContent = statusLabel;
        status.title = 'Session status: ' + statusLabel;
        status.setAttribute('aria-label', 'Session status: ' + statusLabel);
        line.appendChild(status);
        main.appendChild(line);
      }
      function renderSessionModelLegend() {
        if (!menu) return;
        Array.prototype.slice
          .call(menu.querySelectorAll('[data-fb-session-id]'))
          .forEach(function (row) {
            var model = row.querySelector('.fb-session-menu-model');
            if (!model) return;
            var sessionId = row.getAttribute('data-fb-session-id');
            var label = modelLabelForThreadId(sessionId);
            var unknown = label === 'Model unavailable';
            model.className = 'fb-session-menu-model' + (unknown ? ' unknown' : '');
            model.textContent = label;
            model.title = label;
            model.setAttribute('aria-label', 'Model: ' + label);
            var status = row.querySelector('.fb-session-menu-status');
            if (!status) return;
            var statusLabel = sessionStatusForThreadId(sessionId);
            status.className =
              'fb-session-menu-status ' + statusLabel.toLowerCase();
            status.textContent = statusLabel;
            status.title = 'Session status: ' + statusLabel;
            status.setAttribute('aria-label', 'Session status: ' + statusLabel);
          });
        syncSessionModelFilter();
      }
      function sessionModelRows() {
        if (!menu) return [];
        return Array.prototype.slice.call(
          menu.querySelectorAll('.fb-session-menu-item[data-fb-session-id]'),
        );
      }
      function applySessionModelFilter() {
        if (!menu) return;
        var selected = modelFilter ? modelFilter.value || 'all' : 'all';
        modelFilterValue = selected;
        var visible = 0;
        sessionModelRows().forEach(function (row) {
          var model = row.querySelector('.fb-session-menu-model');
          var modelKey = normalizeSessionModelKey(
            model ? model.textContent.trim() : 'Model unavailable',
          );
          var matches = selected === 'all' || modelKey === selected;
          row.hidden = !matches;
          row.setAttribute('aria-hidden', String(!matches));
          if (matches) visible += 1;
        });
        if (modelFilterEmpty) {
          var selectedOption = modelFilter
            ? modelFilter.options[modelFilter.selectedIndex]
            : null;
          modelFilterEmpty.textContent = selectedOption
            ? 'No sessions use ' + selectedOption.textContent + '.'
            : 'No sessions match this model.';
          modelFilterEmpty.hidden = selected === 'all' || visible > 0;
        }
      }
      function syncSessionModelFilter() {
        if (!menu || !modelFilter) return;
        var labels = {};
        sessionModelRows().forEach(function (row) {
          var model = row.querySelector('.fb-session-menu-model');
          var label = model ? model.textContent.trim() : 'Model unavailable';
          if (!label) label = 'Model unavailable';
          labels[normalizeSessionModelKey(label)] = label;
        });
        var selected = modelFilterValue || modelFilter.value || 'all';
        if (selected !== 'all' && !labels[selected]) selected = 'all';
        var optionData = [{ value: 'all', label: 'All models' }];
        Object.keys(labels)
          .sort(function (a, b) {
            return labels[a].localeCompare(labels[b]);
          })
          .forEach(function (key) {
            optionData.push({ value: key, label: labels[key] });
          });
        var optionsMatch =
          modelFilter.options.length === optionData.length &&
          optionData.every(function (item, index) {
            var option = modelFilter.options[index];
            return option.value === item.value && option.textContent === item.label;
          });
        if (!optionsMatch) {
          modelFilter.textContent = '';
          optionData.forEach(function (item) {
            var option = document.createElement('option');
            option.value = item.value;
            option.textContent = item.label;
            modelFilter.appendChild(option);
          });
        }
        modelFilterValue = selected;
        modelFilter.value = selected;
        applySessionModelFilter();
      }
      // Recent (closed) sessions from the app's own catalog API, for the
      // dropdown's "Recent" section: non-archived, titled, not already open as
      // a tab, newest activity first. Same-origin, so it works in the browser
      // port exactly like the app's home screen does.
      function fetchRecent() {
        return fetch('/api/projects', { headers: { Accept: 'application/json' } })
          .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
          })
          .then(function (data) {
            // Model labels are enhancement data; malformed catalog metadata
            // must not hide Recent session rows.
            try {
              updateSessionModelMap(data);
            } catch (e) {}
            var open = {};
            sessionTabs().forEach(function (t) {
              var id = threadIdOf(t);
              if (id) open[id] = true;
            });
            var items = [];
            ((data && data.projects) || []).forEach(function (p) {
              (p.threads || []).forEach(function (th) {
                // Catalog threads inherit project path from their parent
                // project; the API often omits it on each thread object.
                var record = th &&
                  Object.assign({}, th, {
                    projectPath:
                      th.projectPath || p.path || p.projectPath || '',
                  });
                // Named, non-archived, with some activity (the home catalog
                // only renders threads that pass its activity check — mirror
                // that so every listed session can actually be opened).
                // Untitled threads carry the literal title "New thread" in
                // the API and would be ambiguous to open by title, so skip
                // them (the home catalog handles those).
                if (
                  record &&
                  !record.archivedAt &&
                  record.title &&
                  record.title !== 'New thread' &&
                  (record.lastPromptAt || record.branch) &&
                  !open[record.id]
                ) {
                  items.push(record);
                }
              });
            });
            items.sort(function (a, b) {
              return (
                (b.lastPromptAt || b.updatedAt || 0) -
                (a.lastPromptAt || a.updatedAt || 0)
              );
            });
            return items.slice(0, 8);
          });
      }
      // Open a closed session as a tab. The store is module-private, so the
      // only native path is the home catalog: go home, make sure the right
      // project is selected (matching the full path in data-tooltip), then
      // click the matching .home-thread row (its onClick runs the app's own
      // Open a closed session: shared catalog-clicking logic now lives at
      // module scope (openThreadViaHomeCatalog), reused by the home-page
      // Thread history sheet.
      function openRecent(th) {
        close();
        openThreadViaHomeCatalog(th);
      }
      function stopSessionStatusPolling() {
        if (sessionStatusPollTimer) {
          window.clearInterval(sessionStatusPollTimer);
          sessionStatusPollTimer = null;
        }
      }
      function startSessionStatusPolling() {
        stopSessionStatusPolling();
        sessionStatusPollTimer = window.setInterval(function () {
          if (
            !menu ||
            !document.documentElement.contains(menu)
          ) {
            stopSessionStatusPolling();
            return;
          }
          fetchRecent()
            .then(function () {
              if (menu) renderSessionModelLegend();
            })
            .catch(function () {});
        }, 1000);
      }
      function close() {
        stopSessionStatusPolling();
        if (menu) {
          menu.remove();
          menu = null;
          openedActive = null;
        }
        modelFilter = null;
        modelFilterEmpty = null;
        mobileOverlay.dismiss('session-menu');
      }

      function open() {
        close();
        openedActive = activeTab();
        openedIds = tabIds();
        var tabs = sessionTabs();
        menu = document.createElement('div');
        menu.className = 'fb-session-menu';
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', 'Open sessions');

        var head = document.createElement('div');
        head.className = 'fb-session-menu-title';
        head.textContent = 'Sessions';
        menu.appendChild(head);

        var filterRow = document.createElement('div');
        filterRow.className = 'fb-session-menu-filter-row';
        var filterLabel = document.createElement('span');
        filterLabel.className = 'fb-session-menu-filter-label';
        filterLabel.textContent = 'Model';
        modelFilter = document.createElement('select');
        modelFilter.className = 'fb-session-menu-filter';
        modelFilter.setAttribute('aria-label', 'Filter sessions by model');
        modelFilter.addEventListener('change', function () {
          modelFilterValue = modelFilter.value || 'all';
          applySessionModelFilter();
        });
        filterRow.appendChild(filterLabel);
        filterRow.appendChild(modelFilter);
        menu.appendChild(filterRow);
        modelFilterEmpty = document.createElement('div');
        modelFilterEmpty.className = 'fb-session-menu-filter-empty';
        modelFilterEmpty.setAttribute('role', 'status');
        modelFilterEmpty.setAttribute('aria-live', 'polite');
        modelFilterEmpty.hidden = true;
        menu.appendChild(modelFilterEmpty);
        syncSessionModelFilter();

        if (tabs.length === 0) {
          var empty = document.createElement('div');
          empty.className = 'fb-session-menu-empty';
          empty.textContent = 'No open sessions';
          menu.appendChild(empty);
        }
        tabs.forEach(function (tab) {
          var active = tab.classList.contains('active');
          var sessionId = threadIdOf(tab);
          var row = document.createElement('div');
          row.className = 'fb-session-menu-item' + (active ? ' active' : '');
          row.setAttribute('data-fb-session-id', sessionId);

          // Select area: switches to this session via the app's own
          // .tab-select activation.
          var sel = document.createElement('button');
          sel.type = 'button';
          sel.className = 'fb-session-menu-select';
          sel.setAttribute('role', 'menuitemradio');
          sel.setAttribute('aria-checked', String(active));
          var main = document.createElement('span');
          main.className = 'fb-session-menu-main';
          var label = document.createElement('span');
          label.className = 'fb-session-menu-label';
          label.textContent = titleOf(tab);
          main.appendChild(label);
          makeSessionModelLine(main, modelLabelForThreadId(sessionId), sessionId);
          sel.appendChild(main);
          if (active) {
            var check = document.createElement('span');
            check.className = 'fb-session-menu-check';
            check.setAttribute('aria-hidden', 'true');
            check.textContent = '\u2713';
            sel.appendChild(check);
          }
          sel.addEventListener('click', function () {
            var selectedTitle = titleOf(tab);
            var liveTab = liveTabById(sessionId) || tab;
            clickNativeTabSelect(liveTab); // the app's native tab activation
            mobileLiveRegion.announce(
              'Selected session: “' + selectedTitle + '”.',
              'polite',
            );
            close();
          });
          row.appendChild(sel);

          // Close button: closes this session via the app's own .tab-close
          // (which stopPropagates, so it won't also activate the tab). The
          // list refreshes live via the tabbar observer below.
          var closeBtn = document.createElement('button');
          closeBtn.type = 'button';
          closeBtn.className = 'fb-session-menu-close';
          closeBtn.setAttribute(
            'aria-label',
            'Close ' + (titleOf(tab) || 'session'),
          );
          closeBtn.title = 'Close session';
          closeBtn.innerHTML =
            '<svg width="13" height="13" viewBox="0 0 12 12" fill="none" ' +
            'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ' +
            'aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6"/></svg>';
          closeBtn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            var liveTab = liveTabById(sessionId) || tab;
            closeSessionConfirm.request(
              liveTab,
              function () {
                var closed = clickNativeTabClose(liveTab);
                close();
                return closed;
              },
              'session-menu',
            );
          });
          row.appendChild(closeBtn);

          menu.appendChild(row);
        });
        syncSessionModelFilter();

        // Recent (closed) sessions — filled from /api/projects once it
        // resolves; the whole section is dropped when there are none. The
        // section header has a refresh button so the list can be re-fetched
        // without closing and reopening the menu.
        var recentWrap = document.createElement('div');
        recentWrap.className = 'fb-session-menu-recent';
        var recentList = document.createElement('div');
        recentWrap.appendChild(recentList);
        menu.appendChild(recentWrap);
        function fillRecent(items) {
          recentList.textContent = '';
          items.forEach(function (th) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'fb-session-menu-item recent';
            b.setAttribute('role', 'menuitem');
            b.setAttribute('data-fb-session-id', th.id || '');
            // Two-line row: title on top, full project path underneath so
            // sessions from different projects are easy to tell apart.
            var main = document.createElement('span');
            main.className = 'fb-session-menu-main';
            var label = document.createElement('span');
            label.className = 'fb-session-menu-label';
            label.textContent = th.title;
            main.appendChild(label);
            var proj = document.createElement('span');
            proj.className = 'fb-session-menu-project';
            var projectPath = th.projectPath || '';
            proj.textContent = projectPath || 'Project path unavailable';
            main.appendChild(proj);
            makeSessionModelLine(main, modelLabelForThread(th), th.id || '', th);
            b.appendChild(main);
            var time = document.createElement('span');
            time.className = 'fb-session-menu-time';
            time.textContent = relTime(th.lastPromptAt || th.updatedAt);
            b.appendChild(time);
            b.addEventListener('click', function () {
              mobileLiveRegion.announce(
                'Selected recent session: “' + th.title + '”.',
                'polite',
              );
              openRecent(th);
            });
            recentList.appendChild(b);
          });
          syncSessionModelFilter();
        }
        function recentHead() {
          var sec = document.createElement('div');
          sec.className = 'fb-session-menu-section';
          var label = document.createElement('span');
          label.textContent = 'Recent';
          sec.appendChild(label);
          var refresh = document.createElement('button');
          refresh.type = 'button';
          refresh.className = 'fb-session-menu-refresh';
          refresh.setAttribute('aria-label', 'Refresh recent sessions');
          refresh.title = 'Refresh';
          refresh.innerHTML =
            '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" ' +
            'stroke="currentColor" stroke-width="2.2" stroke-linecap="round" ' +
            'stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>' +
            '</svg>';
          refresh.addEventListener('click', function () {
            if (refresh.classList.contains('loading')) return;
            refresh.classList.add('loading');
            fetchRecent()
              .then(function (items) {
                refresh.classList.remove('loading');
                if (!menu || !document.contains(menu)) return;
                if (!items.length) {
                  recentWrap.remove(); // nothing recent anymore
                  return;
                }
                fillRecent(items);
              })
              .catch(function () {
                refresh.classList.remove('loading'); // keep the old list
              });
          });
          sec.appendChild(refresh);
          return sec;
        }
        fetchRecent()
          .then(function (items) {
            if (!menu || !document.contains(menu)) return; // closed meanwhile
            if (!items.length) {
              recentWrap.remove();
              return;
            }
            recentWrap.insertBefore(recentHead(), recentList);
            fillRecent(items);
          })
          .catch(function () {
            if (menu && document.contains(menu)) recentWrap.remove();
          });

        var foot = document.createElement('div');
        foot.className = 'fb-session-menu-foot';
        var actions = [
          [
            'Thread history',
            function () {
              openHistorySheet();
            },
          ],
          [
            'New session',
            function () {
              var n = tabbar.querySelector('.tab-new');
              if (n) n.click();
            },
          ],
          [
            'All sessions',
            function () {
              var h = tabbar.querySelector('.tab.home');
              if (h) h.click();
            },
          ],
        ];
        actions.forEach(function (pair) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'fb-session-menu-item foot';
          b.setAttribute('role', 'menuitem');
          b.textContent = pair[0];
          b.addEventListener('click', function () {
            pair[1]();
            close();
          });
          foot.appendChild(b);
        });
        menu.appendChild(foot);

        document.body.appendChild(menu);
        attachSwipeDownClose(menu, close);
        mobileOverlay.open('session-menu', close);
        startSessionStatusPolling();
      }

      // Trigger: a list icon in the slim header, before the status pill.
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fb-session-switch';
      btn.setAttribute('aria-label', 'Switch session');
      btn.setAttribute('aria-haspopup', 'menu');
      btn.title = 'Switch session';
      btn.innerHTML =
        '<svg width="18" height="18" viewBox="0 0 16 16" fill="none" ' +
        'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
        'aria-hidden="true"><path d="M2 4h8M2 8h8M2 12h8"/>' +
        '<circle cx="13.5" cy="4" r="1.4" fill="currentColor" stroke="none"/>' +
        '<circle cx="13.5" cy="8" r="1.4" fill="currentColor" stroke="none"/>' +
        '<circle cx="13.5" cy="12" r="1.4" fill="currentColor" stroke="none"/></svg>';
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (menu) close();
        else open();
      });
      var anchor =
        tabbar.querySelector('.conn-status') ||
        tabbar.querySelector('.tabbar-account') ||
        null;
      tabbar.insertBefore(btn, anchor);
      // New-session button: the tab strip (and its .tab-new) is collapsed on
      // mobile, so a header "+" is the direct new-thread affordance. It
      // clicks the app's own .tab-new (native new thread in the current
      // project); the CSS hides it on desktop where the tab strip shows it.
      var newBtn = document.createElement('button');
      newBtn.type = 'button';
      newBtn.className = 'fb-new-session';
      newBtn.setAttribute('aria-label', 'New session');
      newBtn.setAttribute('title', 'New session');
      newBtn.innerHTML =
        '<svg width="18" height="18" viewBox="0 0 16 16" fill="none" ' +
        'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ' +
        'aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>';
      newBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var n = tabbar.querySelector('.tab-new');
        if (n) n.click();
      });
      tabbar.insertBefore(newBtn, anchor);
      btn.style.display = hasAnyTab() ? '' : 'none';
      // Attention dot: the app marks a session tab as needing attention with
      // the "unseen" class (not active, not running, and its attention
      // revision is ahead of what was acknowledged — see the app's sl()
      // predicate). Mirror it on the switcher button via the tabbar observer.
      function syncAttention() {
        var needsAttention = sessionTabs().some(function (t) {
          return t.classList.contains('unseen');
        });
        btn.classList.toggle('fb-has-attention', needsAttention);
      }
      syncAttention();

      // Outside tap / Escape / resize / scroll close (capture phase so the
      // toggle runs before the app's own click handling).
      document.addEventListener(
        'click',
        function (ev) {
          if (isCloseConfirmTarget(ev.target)) return;
          if (menu && !menu.contains(ev.target) && !btn.contains(ev.target)) {
            close();
          }
        },
        true,
      );
      document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') close();
      });
      window.addEventListener('resize', close);
      window.addEventListener(
        'scroll',
        function (ev) {
          // Do not close when the user scrolls the menu itself (especially
          // the Recent session list); only external page scrolling dismisses.
          if (menu && menu.contains(ev.target)) return;
          // Streaming follow-scroll animates the transcript while a session
          // works; that must not dismiss the open menu.
          if (ev.target && ev.target.closest && ev.target.closest('.messages, .thread-transcript')) {
            return;
          }
          close();
        },
        true,
      );

      // React re-renders the tabbar on tab changes: hide the button when no
      // session is open (or the layout widens past mobile). While the menu is
      // open, close it if the active session changed, and refresh it live if
      // sessions opened/closed/reordered (e.g. the per-row close button).
      // Compare the active session by its stable thread id, not by element
      // identity: streaming status updates make React replace the tab node,
      // and an element-identity check would close the menu on every token.
      new MutationObserver(function () {
        btn.style.display = hasAnyTab() ? '' : 'none';
        syncAttention();
        if (menu) renderSessionModelLegend();
        if (!menu) return;
        var nowActive = activeTab();
        if (threadIdOf(nowActive) !== threadIdOf(openedActive)) {
          close();
          return;
        }
        // Same session is still active; React may have swapped the element
        // while streaming, so re-anchor to the current node.
        openedActive = nowActive;
        var now = tabIds().join('\u0000');
        if (openedIds && now !== openedIds.join('\u0000')) open();
      }).observe(tabbar, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
      });
      var sessionMq = window.matchMedia(MOBILE);
      watchMedia(sessionMq, function (ev) {
        btn.style.display = hasAnyTab() ? '' : 'none';
        syncAttention();
      });
    });
  }

  // Theme picker (all viewports): a palette button in the header opens a
  // menu with the built-in themes — the app's default dark theme and the
  // Cyberpunk 2077 theme. Selecting one toggles data-fb-theme on <html> (the
  // CSS lives in mobile-ui.css) and persists the choice per browser in
  // localStorage, so Gate Desktop and Gate Mobile on this device keep the
  // same look across reloads. The app's own dark/light switch is untouched;
  // the injected theme layers on top of it. Runs at every viewport — unlike
  // the mobile-only header controls, the button stays visible on desktop.
  var themePickerBound = false;
  function themePicker() {
    if (themePickerBound) return;
    themePickerBound = true;
    // Wait for the main tabbar (like the session switcher), not just <body>:
    // on the real app React mounts the tabbar after parse, and binding to a
    // not-yet-existing header would drop the button forever.
    waitForEl('.tabbar:not(.threadbar)', function () {
      var tabbar = document.querySelector('.tabbar:not(.threadbar)');
      if (!tabbar) return;
      var menu = null;
      var opener = null;
      var THEMES = [
        { id: 'default', label: 'Default dark', swatch: '#7cff3f' },
        { id: THEME_CYBERPUNK, label: 'Cyberpunk 2077', swatch: '#f2d21c' },
        { id: 'retro-punk', label: 'Retro Punk', swatch: '#ff2e63' },
        { id: 'flintstones', label: 'Flintstones', swatch: '#ff7a1a' },
      ];
      function themeLabel(id) {
        for (var i = 0; i < THEMES.length; i++) {
          if (THEMES[i].id === id) return THEMES[i].label;
        }
        return THEME_DEFAULT === id ? 'default dark' : id;
      }
      function applyTheme(id, opts) {
        if (id && id !== THEME_DEFAULT) {
          document.documentElement.setAttribute('data-fb-theme', id);
        } else {
          document.documentElement.removeAttribute('data-fb-theme');
        }
        try {
          if (id && id !== THEME_DEFAULT) localStorage.setItem(THEME_KEY, id);
          else localStorage.removeItem(THEME_KEY);
        } catch (e) {}
        if (!opts || !opts.silent) {
          mobileLiveRegion.announce(
            'Theme set to ' + themeLabel(id) + '.',
            'polite',
          );
        }
        syncAppearancePatch();
      }
      function close() {
        if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
        menu = null;
        if (opener) opener.classList.remove('open');
        opener = null;
        mobileOverlay.dismiss('theme-menu');
      }
      function open(btn) {
        close();
        opener = btn;
        btn.classList.add('open');
        var current = persistedTheme();
        menu = document.createElement('div');
        menu.className = 'fb-theme-menu';
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', 'Theme');
        var title = document.createElement('div');
        title.className = 'fb-theme-menu-title';
        title.textContent = 'Theme';
        menu.appendChild(title);
        THEMES.forEach(function (theme) {
          var option = document.createElement('button');
          option.type = 'button';
          option.className = 'fb-theme-option';
          option.setAttribute('role', 'menuitemradio');
          option.setAttribute('aria-checked', current === theme.id ? 'true' : 'false');
          var swatch = document.createElement('span');
          swatch.className = 'fb-theme-swatch';
          swatch.style.background = theme.swatch;
          swatch.setAttribute('aria-hidden', 'true');
          var label = document.createElement('span');
          label.className = 'fb-theme-label';
          label.textContent = theme.label;
          var check = document.createElement('span');
          check.className = 'fb-theme-check';
          check.setAttribute('aria-hidden', 'true');
          check.textContent = '✓';
          option.appendChild(swatch);
          option.appendChild(label);
          option.appendChild(check);
          option.addEventListener('click', function () {
            applyTheme(theme.id);
            close();
          });
          menu.appendChild(option);
        });
        document.body.appendChild(menu);
        attachSwipeDownClose(menu, close);
        mobileOverlay.open('theme-menu', close);
      }
      function ensure(header) {
        if (!header || header.querySelector('.fb-theme-toggle')) return;
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'fb-theme-toggle';
        btn.setAttribute('aria-label', 'Change theme');
        btn.setAttribute('aria-haspopup', 'menu');
        btn.setAttribute('aria-expanded', 'false');
        btn.title = 'Theme';
        btn.innerHTML =
          '<svg width="18" height="18" viewBox="0 0 16 16" fill="none" ' +
          'stroke="currentColor" stroke-width="1.4" stroke-linecap="round" ' +
          'stroke-linejoin="round" aria-hidden="true">' +
          '<circle cx="8" cy="8" r="6.25"/>' +
          '<path d="M8 1.75a6.25 6.25 0 0 1 0 12.5Z" fill="currentColor" stroke="none"/>' +
          '</svg>';
        btn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          if (menu) close();
          else open(btn);
        });
        var anchor =
          header.querySelector('.conn-status') ||
          header.querySelector('.tabbar-account') ||
          null;
        if (anchor) header.insertBefore(btn, anchor);
        else header.appendChild(btn);
      }
      ensure(tabbar);
      ensure(document.querySelector('.tabbar.threadbar'));
      // React re-renders the tabbar on tab/status changes (streaming tokens
      // swap tab nodes), so re-insert the button if a re-render dropped it.
      // Two observers: the tabbar one catches child re-renders; the parent
      // one (childList only, cheap) catches the tabbar node itself being
      // replaced by a remount. Desktop has no mobile bodySync fallback, so
      // the button must recover on its own.
      new MutationObserver(function () {
        ensure(tabbar);
        ensure(document.querySelector('.tabbar.threadbar'));
      }).observe(tabbar, {
        childList: true,
        subtree: true,
      });
      var tabbarParent = tabbar.parentElement;
      if (tabbarParent) {
        new MutationObserver(function () {
          var current = document.querySelector('.tabbar:not(.threadbar)');
          if (current && current !== tabbar) {
            tabbar = current;
            ensure(tabbar);
          }
          ensure(document.querySelector('.tabbar.threadbar'));
        }).observe(tabbarParent, { childList: true });
      }
      // Outside tap / Escape / resize close, matching the session menu.
      document.addEventListener(
        'click',
        function (ev) {
          if (isCloseConfirmTarget(ev.target)) return;
          if (
            menu &&
            !menu.contains(ev.target) &&
            (!opener || !opener.contains(ev.target))
          ) {
            close();
          }
        },
        true,
      );
      document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') close();
      });
      window.addEventListener('resize', close);
      // Sync the theme across this device's other windows/tabs.
      window.addEventListener('storage', function (ev) {
        if (ev.key !== THEME_KEY) return;
        var pt = persistedTheme();
        if (pt !== THEME_DEFAULT) {
          document.documentElement.setAttribute('data-fb-theme', pt);
        } else {
          document.documentElement.removeAttribute('data-fb-theme');
        }
      });

      // ---- Native Appearance surfaces ----
      // The app's own Appearance UI (account menu group + the new-thread
      // theme switch) only offers Light/Dark/System, so the gate themes were
      // easy to miss. Patch both surfaces with the same Default dark /
      // Cyberpunk 2077 options, styled as native items. The surfaces
      // mount/unmount per open/navigation and React re-renders them after a
      // native themePref change (wiping injected nodes), so patching is
      // idempotent and re-runs on any non-transcript DOM change (debounced
      // like the mobile body sync). Clicking a NATIVE option also clears the
      // gate override, so the app's own switch stays authoritative once the
      // user touches it.
      function optionIcon(kind) {
        if (kind === 'moon') {
          return '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" ' +
            'stroke="currentColor" stroke-width="1.4" stroke-linecap="round" ' +
            'stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M14 9.6A6 6 0 0 1 6.4 2a6 6 0 1 0 7.6 7.6Z"/></svg>';
        }
        return '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" ' +
          'stroke="currentColor" stroke-width="1.4" stroke-linecap="round" ' +
          'stroke-linejoin="round" aria-hidden="true">' +
          '<circle cx="8" cy="8" r="6.25"/>' +
          '<path d="M8 1.75a6.25 6.25 0 0 1 0 12.5Z" fill="currentColor" stroke="none"/>' +
          '</svg>';
      }
      function syncAppearancePatch() {
        var active = persistedTheme();
        document.querySelectorAll('.fb-gate-theme-item, .fb-gate-theme-option').forEach(function (el) {
          var id = el.getAttribute('data-fb-theme-id');
          var on = id === active;
          if (el.classList.contains('theme-option')) {
            el.classList.toggle('on', on);
            el.setAttribute('aria-pressed', on ? 'true' : 'false');
          } else {
            el.setAttribute('aria-checked', on ? 'true' : 'false');
          }
        });
      }
      function patchAppearance() {
        // Account menu: the Appearance group gets a "Gate themes" section.
        var group = document.querySelector('.account-menu [role="group"][aria-label="Appearance"]');
        if (group && !group.querySelector('.fb-gate-theme-item')) {
          var label = document.createElement('div');
          label.className = 'header-menu-label';
          label.textContent = 'Gate themes';
          group.appendChild(label);
          THEMES.forEach(function (theme) {
            var item = document.createElement('button');
            item.type = 'button';
            item.className = 'header-menu-item fb-gate-theme-item';
            item.setAttribute('role', 'menuitemradio');
            item.setAttribute('aria-checked', 'false');
            item.setAttribute('data-fb-theme-id', theme.id);
            item.setAttribute('aria-label', theme.label);
            item.innerHTML =
              optionIcon(theme.id === THEME_CYBERPUNK ? 'cyber' : 'moon') +
              '<span>' + theme.label + '</span>' +
              '<svg class="header-menu-check" width="14" height="14" viewBox="0 0 16 16" ' +
              'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
              'stroke-linejoin="round" aria-hidden="true"><path d="m3 8.5 3.2 3.2L13 4.5"/></svg>';
            item.addEventListener('click', function () {
              applyTheme(theme.id);
            });
            group.appendChild(item);
          });
        }
        // New-thread screen: the Light/Dark/System pill row gets the same
        // two options as icon buttons (tooltips carry the labels).
        var sw = document.querySelector('.new-thread-theme .theme-switch');
        if (sw && !sw.querySelector('.fb-gate-theme-option')) {
          THEMES.forEach(function (theme) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'theme-option fb-gate-theme-option';
            btn.setAttribute('aria-pressed', 'false');
            btn.setAttribute('data-fb-theme-id', theme.id);
            btn.setAttribute('data-tooltip', theme.label);
            btn.setAttribute('aria-label', theme.label);
            btn.title = theme.label;
            btn.innerHTML = optionIcon(theme.id === THEME_CYBERPUNK ? 'cyber' : 'moon');
            btn.addEventListener('click', function () {
              applyTheme(theme.id);
            });
            sw.appendChild(btn);
          });
        }
        syncAppearancePatch();
      }
      var patchTimer = null;
      function schedulePatch() {
        if (patchTimer) return;
        patchTimer = setTimeout(function () {
          patchTimer = null;
          patchAppearance();
        }, 80);
      }
      patchAppearance();
      // A native Light/Dark/System click must clear the gate override;
      // otherwise the cyberpunk theme silently wins over the app's switch.
      document.addEventListener(
        'click',
        function (ev) {
          var target = ev.target && ev.target.closest
            ? ev.target.closest('.header-menu-item, .theme-option')
            : null;
          if (!target) return;
          if (
            target.classList.contains('fb-gate-theme-item') ||
            target.classList.contains('fb-gate-theme-option')
          ) {
            return;
          }
          var inAppearance =
            target.closest('[role="group"][aria-label="Appearance"]') ||
            target.closest('.theme-switch');
          if (!inAppearance) return;
          if (persistedTheme() !== THEME_DEFAULT) {
            applyTheme('default', { silent: true });
          }
        },
        true,
      );
      // Menu open / home navigation mount the Appearance surfaces; React
      // also re-renders them after a native themePref change (wiping
      // injected nodes), so re-patch on any non-transcript DOM change.
      document.addEventListener(
        'click',
        function (ev) {
          var target = ev.target && ev.target.closest
            ? ev.target.closest('.account-trigger, .account-menu, .new-thread-theme, .theme-switch')
            : null;
          if (target) schedulePatch();
        },
        true,
      );
      var appShell = document.querySelector('.app');
      if (appShell) {
        new MutationObserver(function (records) {
          if (records.some(function (record) { return !isTranscriptNode(record.target); })) {
            schedulePatch();
          }
        }).observe(appShell, { childList: true, subtree: true });
      }
    });
  }

  // Sliding tools panel (mobile): the explorer is hidden on mobile — no
  // open drawer, no collapsed rail. A header button (.fb-panel-toggle)
  // summons it as a panel that slides in from the right over the chat,
  // with a dimmed scrim behind; tapping the scrim, the panel header's own
  // close (the app's .explorer-toggle), or Escape dismisses it. It toggles
  // via the app's own collapse control, so uiPrefs.explorerCollapsed stays
  // consistent and persists.
  var panelBound = false;
  function sidePanel() {
    if (panelBound) return;
    panelBound = true;
    if (!window.matchMedia(MOBILE).matches) return;
    waitForEl('.tabbar:not(.threadbar)', function () {
      var tabbar = document.querySelector('.tabbar:not(.threadbar)');
      if (!tabbar) return;

      var scrim = null;
      function explorer() {
        return document.querySelector('.explorer');
      }
      function isOpen() {
        var e = explorer();
        return !!e && !e.classList.contains('collapsed');
      }
      function removeScrim() {
        if (scrim) {
          scrim.remove();
          scrim = null;
        }
      }
      function toggleViaApp() {
        var e = explorer();
        if (!e) return;
        var t = e.querySelector('.explorer-toggle');
        if (t) t.click(); // the app's own expand/collapse control
      }
      function closePanel() {
        var e = explorer();
        if (e && !e.classList.contains('collapsed')) toggleViaApp();
      }
      var explorerObserver = null;
      var observedExplorer = null;
      function observeExplorer() {
        var e = explorer();
        if (e === observedExplorer) return;
        if (explorerObserver) explorerObserver.disconnect();
        explorerObserver = null;
        observedExplorer = e;
        if (e) {
          explorerObserver = new MutationObserver(scheduleBodySync);
          explorerObserver.observe(e, {
            attributes: true,
            attributeFilter: ['class'],
          });
        }
      }
      var lastPanelThread = null;
      function sync() {
        if (!window.matchMedia(MOBILE).matches) {
          btn.style.display = 'none';
          removeScrim();
          observeExplorer();
          return;
        }
        observeExplorer();
        var open = isOpen();
        btn.style.display = open ? 'none' : '';
        if (open && !scrim) {
          scrim = document.createElement('div');
          scrim.className = 'fb-panel-scrim';
          scrim.setAttribute('aria-hidden', 'true');
          scrim.addEventListener('click', closePanel);
          document.body.appendChild(scrim);
        } else if (!open && scrim) {
          removeScrim();
        }
        // Per-thread persistence (same model as the context card): when the
        // active thread changes, restore that thread's remembered panel
        // state; opening records the current thread, closing on it clears
        // it. The home screen (no thread) is left alone.
        var tid = activeThreadId();
        if (tid !== lastPanelThread) {
          lastPanelThread = tid;
          if (tid) {
            var wantedOpen = threadStateHas(PANEL_KEY, tid);
            if (wantedOpen !== open) toggleViaApp();
          }
          // Let the panel settle before recording anything — recording on
          // this tick would attribute the old thread's state to the new one.
          return;
        }
        if (tid) {
          var rememberedOpen = threadStateHas(PANEL_KEY, tid);
          if (open !== rememberedOpen) {
            threadStateSet(PANEL_KEY, tid, open);
          }
        }
        if (open) {
          mobileOverlay.open('tools-panel', function () {
            if (window.matchMedia(MOBILE).matches) closePanel();
          });
        } else {
          mobileOverlay.dismiss('tools-panel');
        }
      }

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fb-panel-toggle';
      btn.setAttribute('aria-label', 'Open tools panel');
      btn.title = 'Tools';
      btn.innerHTML =
        '<svg width="17" height="17" viewBox="0 0 16 16" fill="none" ' +
        'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
        'stroke-linejoin="round" aria-hidden="true">' +
        '<rect x="1.5" y="2.5" width="13" height="11" rx="2"/>' +
        '<path d="M6 2.5v11"/></svg>';
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        toggleViaApp();
      });
      var anchor =
        tabbar.querySelector('.fb-session-switch') ||
        tabbar.querySelector('.conn-status') ||
        null;
      tabbar.insertBefore(btn, anchor);

      document.addEventListener('keydown', function (ev) {
        if (window.matchMedia(MOBILE).matches && ev.key === 'Escape') {
          closePanel();
        }
      });
      // React re-renders constantly; class changes on the explorer (open /
      // collapsed) plus its mount/unmount are enough to keep scrim + button
      // in sync.
      watchMobileBody(sync);
      var panelMq = window.matchMedia(MOBILE);
      watchMedia(panelMq, function (ev) {
        if (ev.matches) sync();
        else {
          removeScrim();
          btn.style.display = 'none';
        }
      });
      sync();
    });
  }

  // Composer context chips (agent/model/effort/workspace) collapse into a
  // button in the slim header so the composer stays clean and the bottom of
  // the chat stays readable (see mobile-ui.css). Tapping the button drops a
  // card below the header; outside tap, Escape, scroll, or resize dismisses
  // it. The composer unmounts on the home screen, so the composer element is
  // re-acquired on every use.
  var ctxBound = false;
  function composerCtx() {
    if (ctxBound || !window.matchMedia(MOBILE).matches) return;
    // Do not consume one-shot guard on desktop: a later rotation into
    // mobile must still create composer controls.
    ctxBound = true;
    waitForEl('.tabbar:not(.threadbar)', function () {
      var tabbar = document.querySelector('.tabbar:not(.threadbar)');
      if (!tabbar) return;

      var fab = null;
      var pill = null;
      var pillLabel = null;
      var effortPill = null;
      var effortPillLabel = null;
      var quotaPill = null;
      var quotaPillLabel = null;
      var pillRow = null;
      var streamingIndicator = null;
      var pickerOpenedAt = 0;
      var popupEl = null;
      var closingTimer = null;
      var lastCtxThread = null;
      var composerObserver = null;
      var observedComposer = null;
      // Per-thread persistence: the card's open state is remembered per
      // thread (localStorage), so returning to a thread or reloading the
      // page restores the chip layout the user left it in.
      var STORE_KEY = 'fb-ui:ctx-open-thread';
      function getComposer() {
        return document.querySelector('.composer');
      }
      function syncStreamingIndicator(composer) {
        if (!streamingIndicator) return;
        var mobile = window.matchMedia(MOBILE).matches;
        var stop = composer
          ? composer.querySelector('.composer-row .stop')
          : null;
        var streaming = !!stop;
        streamingIndicator.style.display =
          mobile && streaming ? 'inline-flex' : 'none';
        streamingIndicator.setAttribute('aria-hidden', String(!streaming));
      }
      function observeComposer(composer) {
        if (composer === observedComposer) return;
        if (composerObserver) composerObserver.disconnect();
        composerObserver = null;
        observedComposer = composer;
        if (composer) {
          // The global observer handles mount/unmount and child changes. This
          // narrow observer adds only the class changes needed for ready/send,
          // stop, and the native picker without watching the transcript.
          composerObserver = new MutationObserver(scheduleBodySync);
          composerObserver.observe(composer, {
            attributes: true,
            childList: true,
            subtree: true,
            attributeFilter: ['class'],
          });
        }
      }
      function isOpen() {
        return root.classList.contains('fb-ctx-open');
      }
      function makeStreamingIndicator() {
        var status = document.createElement('span');
        status.className = 'fb-streaming-indicator';
        status.style.display = 'none';
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        status.setAttribute('aria-label', 'Agent is responding');
        status.setAttribute('aria-hidden', 'true');
        var dot = document.createElement('span');
        dot.className = 'fb-streaming-indicator-dot';
        dot.setAttribute('aria-hidden', 'true');
        status.appendChild(dot);
        var label = document.createElement('span');
        label.className = 'fb-streaming-indicator-label';
        label.textContent = 'Streaming';
        status.appendChild(label);
        return status;
      }
      function makeFab() {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'fb-ctx-fab';
        b.setAttribute('aria-label', 'Agent and model settings');
        b.title = 'Agent & model';
        var chev = document.createElement('span');
        chev.className = 'fb-ctx-chev';
        chev.setAttribute('aria-hidden', 'true');
        chev.innerHTML =
          '<svg width="18" height="18" viewBox="0 0 16 16" fill="none" ' +
          'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
          'stroke-linejoin="round"><path d="M4 6.5 8 10.5l4-4"/></svg>';
        b.appendChild(chev);
        if (isOpen()) b.classList.add('open');
        b.setAttribute('aria-expanded', String(isOpen()));
        b.addEventListener('click', function (ev) {
          ev.stopPropagation();
          toggle();
        });
        return b;
      }
      function syncFab() {
        if (!fab) return;
        var open = isOpen();
        var mobile = window.matchMedia(MOBILE).matches;
        // Hide the header button when there's no composer or the layout is
        // wide (the feature remains bound so rotation can re-enter cleanly).
        fab.style.display = mobile && getComposer() ? '' : 'none';
        fab.classList.toggle('open', open);
        fab.setAttribute('aria-expanded', String(open));
      }
      function open() {
        clearTimeout(closingTimer);
        if (popupEl) popupEl.classList.remove('fb-ctx-closing');
        root.classList.add('fb-ctx-open');
        var composer = getComposer();
        popupEl = composer
          ? composer.querySelector('.composer-context')
          : null;
        threadStateSet(STORE_KEY, activeThreadId(), true);
        syncFab();
        mobileOverlay.open('context-card', close);
      }
      function finishClose() {
        clearTimeout(closingTimer);
        root.classList.remove('fb-ctx-open');
        if (popupEl) popupEl.classList.remove('fb-ctx-closing');
        popupEl = null;
        syncFab();
      }
      function close(preserveState) {
        var managed = !!(preserveState && preserveState.fromManager);
        var preserve =
          preserveState === true ||
          !!(preserveState && preserveState.preserveState);
        if (!isOpen()) {
          mobileOverlay.dismiss('context-card');
          return;
        }
        // Breakpoint teardown hides the card without changing the user's
        // remembered preference; all user dismissals clear this thread's
        // flag.
        if (!preserve) {
          threadStateSet(STORE_KEY, activeThreadId(), false);
        }
        mobileOverlay.dismiss('context-card');
        var composer = getComposer();
        popupEl = composer
          ? composer.querySelector('.composer-context')
          : null;
        syncFab(); // chevron flips while the card slides away
        if (
          !popupEl ||
          managed ||
          (preserve && !window.matchMedia(MOBILE).matches)
        ) {
          finishClose();
          return;
        }
        popupEl.classList.add('fb-ctx-closing');
        var done = function () {
          finishClose();
        };
        popupEl.addEventListener('transitionend', done, { once: true });
        closingTimer = setTimeout(done, 260); // safety net
      }
      function toggle() {
        if (isOpen()) close();
        else open();
      }

      // Action bar inside the card: attach / stop / stash / send. The app's
      // own buttons in .composer-row are hidden on mobile (CSS); each card
      // button clicks the hidden original so every behavior stays native.
      var actions = null;
      var stopBtn = null;
      var stashBtn = null;
      var sendBtn = null;
      function actionBtn(cls, label, iconPath, onClick) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'fb-ctx-action ' + cls;
        b.setAttribute('aria-label', label);
        b.title = label;
        b.innerHTML =
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" ' +
          'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ' +
          'stroke-linejoin="round" aria-hidden="true">' + iconPath + '</svg>';
        b.addEventListener('click', function (ev) {
          ev.stopPropagation();
          onClick();
        });
        return b;
      }
      function makeActions() {
        var wrap = document.createElement('div');
        wrap.className = 'fb-ctx-actions';
        wrap.appendChild(
          actionBtn(
            'attach',
            'Attach files, photos, or a folder',
            '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
            function () {
              var c = getComposer();
              var a = c ? c.querySelector('.composer-row .attach') : null;
              if (a) a.click();
            },
          ),
        );
        stashBtn = actionBtn(
          'stash',
          'Open the stash',
          '<path d="M22 12h-6l-2 3h-4l-2-3H2"/>' +
            '<path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
          function () {
            var c = getComposer();
            var k = c ? c.querySelector('.composer-row .stash-key') : null;
            if (k) k.click();
          },
        );
        wrap.appendChild(stashBtn);
        stopBtn = actionBtn(
          'stop',
          'Stop the running turn',
          '<rect x="4" y="4" width="16" height="16" rx="3"/>',
          function () {
            var c = getComposer();
            var s = c ? c.querySelector('.composer-row .stop') : null;
            if (s) s.click();
          },
        );
        wrap.appendChild(stopBtn);
        sendBtn = actionBtn(
          'send',
          'Send message',
          '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
          function () {
            var c = getComposer();
            var s = c ? c.querySelector('.composer-row .send-key') : null;
            if (s) s.click();
          },
        );
        wrap.appendChild(sendBtn);
        return wrap;
      }
      function syncActions() {
        if (!fab) return;
        var mobile = window.matchMedia(MOBILE).matches;
        var composer = getComposer();
        observeComposer(composer);
        syncStreamingIndicator(composer);
        fab.style.display = mobile && composer ? '' : 'none';
        fab.classList.toggle('open', isOpen());
        fab.setAttribute('aria-expanded', String(isOpen()));
        // Floating model + reasoning pills: keep both settings visible on
        // fresh sessions, where the context card starts closed. Each pill
        // still clicks the app's native trigger, so its menu and selection
        // state remain authoritative.
        if (pill) {
          pill.style.display = mobile && composer ? '' : 'none';
          if (composer && pillLabel) {
            var nameEl =
              composer.querySelector('.agent-model') ||
              composer.querySelector('.agent-name');
            if (nameEl && nameEl.textContent.trim()) {
              pillLabel.textContent = nameEl.textContent.trim();
            }
          }
        }
        if (effortPill) {
          var effort = composer
            ? composer.querySelector('.effort-trigger')
            : null;
          effortPill.style.display = mobile && composer && effort ? '' : 'none';
          effortPill.disabled = !effort || !!effort.disabled;
          if (effortPillLabel) {
            var effortValue = effort
              ? effort.querySelector('.effort-trigger-value')
              : null;
            effortPillLabel.textContent = effortValue
              ? 'Reasoning: ' + effortValue.textContent.trim()
              : 'Reasoning';
          }
        }
        if (quotaPill) {
          var quota = composer
            ? composer.querySelector('.context-quota')
            : null;
          var quotaText = '';
          if (quota) {
            var fullQuota = quota.querySelector('.quota-full');
            var compactQuota = quota.querySelector('.quota-compact');
            var visibleQuota = [fullQuota, compactQuota].find(function (el) {
              if (!el) return false;
              var style = window.getComputedStyle(el);
              return style.display !== 'none' && style.visibility !== 'hidden';
            });
            quotaText = (visibleQuota || quota).textContent.trim();
          }
          quotaPill.style.display = mobile && composer && quota ? '' : 'none';
          quotaPill.disabled = !quota;
          if (quotaPillLabel) {
            quotaPillLabel.textContent = quotaText
              ? 'Time: ' + quotaText
              : 'Time limit';
          }
          if (quota) {
            quotaPill.title =
              quota.getAttribute('data-tooltip') || 'Session time limit';
          } else {
            quotaPill.title = 'Session time limit unavailable';
          }
        }
        if (
          mobile &&
          pickerOpenedAt &&
          (!composer ||
            (!composer.querySelector('.agent-menu') &&
              !composer.querySelector('.effort-menu'))) &&
          Date.now() - pickerOpenedAt > 500
        ) {
          pickerOpenedAt = 0;
          if (isOpen()) close();
        }
        if (!mobile) {
          return;
        }
        // Auto-restore: when the active thread changes (switch, return, or
        // reload), match the card to that thread's own remembered state.
        var tid = activeThreadId();
        if (tid !== lastCtxThread) {
          lastCtxThread = tid;
          var wantedOpen = tid && threadStateHas(STORE_KEY, tid);
          if (wantedOpen && !isOpen()) open();
          else if (tid && !wantedOpen && isOpen()) close();
        }
        if (!actions || !composer) return;
        var row = composer.querySelector('.composer-row');
        if (!row) return;
        stopBtn.style.display = row.querySelector('.stop') ? '' : 'none';
        stashBtn.style.display = row.querySelector('.stash-key') ? '' : 'none';
        sendBtn.classList.toggle(
          'ready',
          !!row.querySelector('.send-key.ready'),
        );
      }

      // Floating model selector just above the message box: a compact pill
      // showing the current model that opens the app's model picker directly
      // (via its own .agent-trigger). The card is opened underneath so the
      // picker's menu has a visible parent, then tidied away when the menu
      // closes.
      function makePill() {
        var p = document.createElement('button');
        p.type = 'button';
        p.className = 'fb-model-pill';
        p.setAttribute('aria-label', 'Select model');
        p.title = 'Select model';
        var label = document.createElement('span');
        label.className = 'fb-model-pill-label';
        label.textContent = 'Model';
        p.appendChild(label);
        var chev = document.createElement('span');
        chev.className = 'fb-model-pill-chev';
        chev.setAttribute('aria-hidden', 'true');
        chev.innerHTML =
          '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" ' +
          'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
          'stroke-linejoin="round"><path d="M4 6.5 8 10.5l4-4"/></svg>';
        p.appendChild(chev);
        p.addEventListener('click', function (ev) {
          ev.stopPropagation();
          if (!isOpen()) {
            open(); // card becomes the picker menu's parent
            pickerOpenedAt = Date.now();
          }
          var c = getComposer();
          var t = c ? c.querySelector('.agent-trigger') : null;
          if (t) t.click(); // the app's own model-picker toggle
        });
        return p;
      }
      function makeEffortPill() {
        var p = document.createElement('button');
        p.type = 'button';
        p.className = 'fb-effort-pill';
        p.setAttribute('aria-label', 'Select reasoning effort');
        p.title = 'Select reasoning effort';
        var label = document.createElement('span');
        label.className = 'fb-effort-pill-label';
        label.textContent = 'Reasoning';
        p.appendChild(label);
        var chev = document.createElement('span');
        chev.className = 'fb-effort-pill-chev';
        chev.setAttribute('aria-hidden', 'true');
        chev.innerHTML =
          '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" ' +
          'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
          'stroke-linejoin="round"><path d="M4 6.5 8 10.5l4-4"/></svg>';
        p.appendChild(chev);
        p.addEventListener('click', function (ev) {
          ev.stopPropagation();
          var c = getComposer();
          var t = c ? c.querySelector('.effort-trigger') : null;
          if (!t || t.disabled) return;
          if (!isOpen()) {
            open(); // card becomes the effort menu's parent
            pickerOpenedAt = Date.now();
          }
          t.click(); // the app's own reasoning-effort listbox
        });
        return p;
      }
      function makeQuotaPill() {
        var p = document.createElement('button');
        p.type = 'button';
        p.className = 'fb-time-pill';
        p.setAttribute('aria-label', 'Session time limit');
        p.title = 'Session time limit';
        var icon = document.createElement('span');
        icon.className = 'fb-time-pill-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.innerHTML =
          '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" ' +
          'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
          'stroke-linejoin="round"><circle cx="8" cy="8" r="5.5"/>' +
          '<path d="M8 4.8v3.5l2.2 1.3"/></svg>';
        p.appendChild(icon);
        var label = document.createElement('span');
        label.className = 'fb-time-pill-label';
        label.textContent = 'Time limit';
        p.appendChild(label);
        p.addEventListener('click', function (ev) {
          ev.stopPropagation();
          if (p.disabled) return;
          if (!isOpen()) open();
        });
        return p;
      }

      streamingIndicator = makeStreamingIndicator();
      fab = makeFab();
      var anchor =
        tabbar.querySelector('.fb-panel-toggle') ||
        tabbar.querySelector('.fb-session-switch') ||
        tabbar.querySelector('.conn-status') ||
        null;
      tabbar.insertBefore(streamingIndicator, anchor);
      tabbar.insertBefore(fab, anchor);
      actions = makeActions();
      pillRow = document.createElement('div');
      pillRow.className = 'fb-composer-pills';
      pill = makePill();
      pillLabel = pill.querySelector('.fb-model-pill-label');
      effortPill = makeEffortPill();
      effortPillLabel = effortPill.querySelector('.fb-effort-pill-label');
      quotaPill = makeQuotaPill();
      quotaPillLabel = quotaPill.querySelector('.fb-time-pill-label');
      pillRow.appendChild(pill);
      pillRow.appendChild(effortPill);
      pillRow.appendChild(quotaPill);
      var composer0 = getComposer();
      if (composer0) composer0.appendChild(pillRow);

      // React re-renders constantly (the composer unmounts on the home
      // screen); a body observer keeps the header button, the action bar
      // inside the card, and their state in sync.
      watchMobileBody(function () {
        var headerAnchor =
          tabbar.querySelector('.fb-panel-toggle') ||
          tabbar.querySelector('.fb-session-switch') ||
          tabbar.querySelector('.conn-status') ||
          null;
        if (!tabbar.contains(streamingIndicator)) {
          tabbar.insertBefore(streamingIndicator, headerAnchor);
        }
        if (!tabbar.contains(fab)) {
          tabbar.insertBefore(fab, headerAnchor);
        }
        var composer = getComposer();
        if (composer) {
          if (!composer.contains(pillRow)) composer.appendChild(pillRow);
          var card = composer.querySelector('.composer-context');
          if (card && !card.contains(actions)) {
            card.appendChild(actions);
          }
        }
        syncActions();
      });
      syncActions();

      document.addEventListener(
        'click',
        function (ev) {
          if (!isOpen()) return;
          var composer = getComposer();
          var popup = composer
            ? composer.querySelector('.composer-context')
            : null;
          if (popup && popup.contains(ev.target)) return;
          if (fab && fab.contains(ev.target)) return;
          if (
            (pill && pill.contains(ev.target)) ||
            (effortPill && effortPill.contains(ev.target)) ||
            (quotaPill && quotaPill.contains(ev.target))
          ) {
            return;
          }
          // The model-sheet close button lives in <body> (outside the popup)
          // — dismissing the sheet shouldn't also dismiss the popup.
          if (
            ev.target.closest &&
            ev.target.closest('.fb-model-sheet-close')
          ) {
            return;
          }
          close();
        },
        true,
      );
      document.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Escape') return;
        // Let an app-owned nested menu consume Escape first; the unified
        // manager will dismiss that top layer while this card remains open.
        var nested = document.querySelector(
          '.agent-menu, .header-menu, .account-menu, .effort-menu, .stash-menu, ' +
            '.slash-menu, .home-context-menu, .context-usage-popover, ' +
            '.open-in-menu, .new-thread-project-menu',
        );
        if (!nested) close();
      });
      // The card is fixed at the top, so scrolling the chat no longer
      // dismisses it (that would fight the persistence). Only leave the
      // mobile layout closes it; within mobile widths it stays put across
      // rotation so the remembered state survives.
      var ctxMq = window.matchMedia(MOBILE);
      watchMedia(ctxMq, function (ev) {
        if (!ev.matches) {
          close(true);
          if (fab) fab.style.display = 'none';
          if (pillRow) pillRow.style.display = 'none';
          return;
        }
        var tid = activeThreadId();
        if (tid && threadStateHas(STORE_KEY, tid) && !isOpen()) open();
        syncActions();
      });
    });
  }

  // Mobile report access: the original feedback pill is hidden below the
  // mobile breakpoint. The active main thread keeps Report an issue in its
  // title menu; home and popout modes get a compact header affordance so the
  // action is never unavailable.
  var reportBound = false;
  function mobileReportAccess() {
    if (reportBound) return;
    reportBound = true;
    if (!window.matchMedia(MOBILE).matches) return;
    waitForEl('body', function () {
      function clickReport() {
        var fb = document.querySelector('.global-feedback');
        if (fb) fb.click();
      }
      function ensure(header) {
        if (!header || header.querySelector('.fb-mobile-report')) return;
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'fb-mobile-report';
        button.setAttribute('aria-label', 'Report an issue');
        button.title = 'Report an issue';
        button.innerHTML =
          '<svg width="17" height="17" viewBox="0 0 16 16" fill="none" ' +
          'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
          'stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M8 2.25 14 13H2L8 2.25Z"/>' +
          '<path d="M8 6v3.2M8 11.2v.1"/></svg>';
        button.addEventListener('click', function (ev) {
          ev.stopPropagation();
          clickReport();
        });
        var anchor =
          header.querySelector('.conn-status') ||
          header.querySelector('.tabbar-account') ||
          null;
        if (anchor) header.insertBefore(button, anchor);
        else header.appendChild(button);
      }
      function sync() {
        if (!window.matchMedia(MOBILE).matches) return;
        ensure(document.querySelector('.tabbar:not(.threadbar)'));
        ensure(document.querySelector('.tabbar.threadbar'));
      }
      watchMobileBody(sync);
      sync();
    });
  }

  // Thread-window (popout) mode: the header is a bare .tabbar.threadbar
  // (title + status) with no tabs, and the browser port has no window
  // controls either. Add a back button that closes the popout and returns
  // focus to the opener — the app itself closes the popout when the active
  // thread is cleared, so closing is the correct "back". React re-renders
  // this header (e.g. connection state), so a MutationObserver re-inserts the
  // button if React ever removes it. Runs at every viewport (the browser port
  // has no tabs/window controls anywhere).
  function threadWindowBack() {
    waitForEl(
      '.tabbar.threadbar',
      function () {
        var header = document.querySelector('.tabbar.threadbar');
        if (!header) return;
        function ensure() {
          if (header.querySelector('.fb-thread-back')) return;
          var back = document.createElement('button');
          back.type = 'button';
          back.className = 'fb-thread-back';
          back.setAttribute('aria-label', 'Back to Freebuff');
          back.title = 'Back';
          back.innerHTML =
            '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" ' +
            'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
            'stroke-linejoin="round" aria-hidden="true"><path d="M10 3 5 8l5 5"/></svg>';
          back.addEventListener('click', function () {
            if (window.opener) {
              try {
                window.opener.focus();
              } catch (e) {}
            }
            window.close();
            // window.close() is ignored for non-script-opened windows —
            // fall back.
            setTimeout(function () {
              if (!window.closed) {
                try {
                  history.back();
                } catch (e) {}
              }
            }, 60);
          });
          header.insertBefore(back, header.firstChild);
        }
        ensure();
        new MutationObserver(ensure).observe(header, { childList: true });
      },
      15000,
    );
  }

  // Browser-port reload cleanup. The app persists tabs but not the home tab
  // flag: on reload the previous home tab is restored as an untitled
  // "New thread" tab while the app creates a fresh home tab, so every refresh
  // leaks one duplicate session. Remember the home tab's id in sessionStorage
  // (per-tab, survives reload but not new tabs) and close the restored phantom
  // once the replacement home tab has mounted. Runs at every viewport because
  // the leak is native to the browser port, not to the mobile layout.
  var HOME_TAB_KEY = 'fb-ui:home-tab-id';
  var reloadCleanupBound = false;
  function browserReloadCleanup() {
    if (reloadCleanupBound) return;
    reloadCleanupBound = true;
    function homeId() {
      var tab = document.querySelector('.tabbar:not(.threadbar) .tab.home');
      var sel = tab && tab.querySelector('.tab-select');
      return sel && sel.id ? sel.id : '';
    }
    function remember() {
      var id = homeId();
      if (!id) return;
      try {
        sessionStorage.setItem(HOME_TAB_KEY, id);
      } catch (e) {}
    }
    function phantomTab(storedId) {
      if (!storedId) return null;
      var tabs = document.querySelectorAll('.tabbar:not(.threadbar) .tab');
      for (var i = 0; i < tabs.length; i++) {
        if (tabs[i].classList.contains('home')) continue;
        var sel = tabs[i].querySelector('.tab-select');
        if (sel && sel.id === storedId) return tabs[i];
      }
      return null;
    }
    function cleanup() {
      // Wait for hJ() to mount the replacement home tab before deciding the
      // restored copy is a phantom rather than the real (slow) home tab.
      if (!document.querySelector('.tabbar:not(.threadbar) .tab.home')) {
        return;
      }
      var stored = '';
      try {
        stored = sessionStorage.getItem(HOME_TAB_KEY) || '';
      } catch (e) {}
      var phantom = phantomTab(stored);
      if (!phantom || phantom.classList.contains('active')) return;
      var close = phantom.querySelector('.tab-close');
      if (close) close.click(); // app's own closeTab; empty tab has no draft
      try {
        sessionStorage.removeItem(HOME_TAB_KEY);
      } catch (e) {}
      remember(); // record replacement home tab for the next reload
    }
    waitForEl('.tabbar:not(.threadbar)', function () {
      var tabbar = document.querySelector('.tabbar:not(.threadbar)');
      if (!tabbar) return;
      remember();
      var timer = null;
      function schedule() {
        if (timer) return;
        timer = setTimeout(function () {
          timer = null;
          cleanup();
        }, 400);
      }
      new MutationObserver(schedule).observe(tabbar, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
      });
      schedule();
    });
    window.addEventListener('pagehide', remember);
  }

  // Mobile features are bound lazily, but remain ready for viewport changes.
  // This matters when a browser starts with a desktop layout and rotates into
  // portrait: the original one-shot guards otherwise skip every mobile hook.
  var mobileFeaturesBound = false;
  var mobileTabbar = null;
  function bindMobileFeatures() {
    var current = document.querySelector('.tabbar:not(.threadbar)');
    var changedRoot = !!current && current !== mobileTabbar;
    if (mobileFeaturesBound && !changedRoot) {
      if (!current) {
        waitForEl('.tabbar:not(.threadbar)', function () {
          mobileTabbar = document.querySelector('.tabbar:not(.threadbar)');
        });
      }
      return;
    }
    if (changedRoot) {
      // Old document-level listeners are harmless after their detached
      // tabbar is gone; reset the one-shot guards so the live root gets fresh
      // handlers instead of leaving rotation with stale references.
      tabMenuBound = false;
      sessionBound = false;
      panelBound = false;
      ctxBound = false;
    }
    tabTitleMenu();
    modelSheet();
    sessionSwitcher();
    sidePanel();
    composerCtx();
    mobileReportAccess();
    mobileFeaturesBound = true;
    if (current) mobileTabbar = current;
    else {
      waitForEl('.tabbar:not(.threadbar)', function () {
        mobileTabbar = document.querySelector('.tabbar:not(.threadbar)');
      });
    }
  }
  function hideMobileChrome() {
    var modelMenu = document.querySelector('.composer-context .agent-menu');
    var trigger = document.querySelector('.composer .agent-trigger');
    if (modelMenu && trigger) trigger.click();
    document
      .querySelectorAll(
        '.fb-tab-menu, .fb-session-menu, .fb-panel-scrim, .fb-model-sheet-close',
      )
      .forEach(function (el) {
        el.remove();
      });
    root.classList.remove('fb-ctx-open');
    document
      .querySelectorAll('.composer-context.fb-ctx-closing')
      .forEach(function (el) {
        el.classList.remove('fb-ctx-closing');
      });
    document
      .querySelectorAll(
        '.fb-streaming-indicator, .fb-ctx-fab, .fb-panel-toggle, .fb-model-pill, .fb-effort-pill, .fb-time-pill, .fb-composer-pills, .fb-mobile-report',
      )
      .forEach(function (el) {
        el.style.display = 'none';
      });
  }
  function restoreMobileChrome() {
    if (!window.matchMedia(MOBILE).matches) return;
    var composer = !!document.querySelector('.composer');
    var explorer = document.querySelector('.explorer');
    // Any tab (including the boot-home tab) keeps the switcher reachable; it
    // is the mobile path to Recent sessions and New session.
    var sessions = document.querySelectorAll(
      '.tabbar:not(.threadbar) .tab',
    ).length;
    document.querySelectorAll('.fb-ctx-fab, .fb-composer-pills').forEach(function (el) {
      el.style.display = composer ? '' : 'none';
    });
    document.querySelectorAll('.fb-streaming-indicator').forEach(function (el) {
      el.style.removeProperty('display');
    });
    document.querySelectorAll('.fb-session-switch').forEach(function (el) {
      el.style.display = sessions ? '' : 'none';
    });
    document.querySelectorAll('.fb-panel-toggle').forEach(function (el) {
      el.style.display = explorer && explorer.classList.contains('collapsed') ? '' : 'none';
    });
    document.querySelectorAll('.fb-mobile-report').forEach(function (el) {
      el.style.removeProperty('display');
    });
  }
  function watchMedia(query, fn) {
    if (query.addEventListener) query.addEventListener('change', fn);
    else if (query.addListener) query.addListener(fn);
  }
  // User messages collapse so a long prompt does not fill the whole
  // transcript; "Show more" expands the bubble back to full height. Runs
  // at every viewport (bound once at init; enterMobile re-call is a no-op).
  // Only applied to overflow bubbles (measured once, then skipped forever).
  // Expansions persist per message (threadId:msgId) in localStorage, so a
  // message the user opened stays open across reloads and thread switches.
  var msgCompactBound = false;
  var msgCompactProcessed = null;
  var msgExpandedSet = null;
  var MSG_EXPANDED_KEY = 'fb.msg.expanded';
  function msgKeyOf(bubble) {
    var row = bubble.closest && bubble.closest('.msg');
    var mid = row && row.getAttribute('data-msg-id');
    if (!mid) return null;
    var ws = document.getElementById('thread-workspace');
    var tid = '';
    if (ws) {
      var lab = ws.getAttribute('aria-labelledby') || '';
      tid = lab.replace(/^thread-tab-/, '');
    }
    return tid + ':' + mid;
  }
  function loadExpandedMessages() {
    try {
      var raw = localStorage.getItem(MSG_EXPANDED_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? new Set(arr) : new Set();
    } catch (e) {
      return new Set();
    }
  }
  function saveExpandedMessages() {
    try {
      // Keep the newest 300 so the store cannot grow without bound.
      var arr = Array.from(msgExpandedSet).slice(-300);
      localStorage.setItem(MSG_EXPANDED_KEY, JSON.stringify(arr));
    } catch (e) {}
  }
  function isLongBubble(b) {
    var key = msgKeyOf(b);
    return (
      b.classList.contains('fb-msg-collapsed') ||
      b.classList.contains('fb-msg-expanded') ||
      !!(key && msgExpandedSet && msgExpandedSet.has(key))
    );
  }
  // The fold button lives on the message ROW, not inside the bubble: the
  // bubble itself is clipped (max-height + overflow) while collapsed, so a
  // button inside it would be cut off on long messages. The row is a flex
  // column aligned to the message edge, so the button lines up for free.
  function foldButtonFor(bubble) {
    var row = bubble.closest && bubble.closest('.msg');
    if (!row) return null;
    var btn = row.querySelector('.fb-msg-expand');
    if (btn) return btn;
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fb-msg-expand';
    row.appendChild(btn);
    return btn;
  }
  function foldLabelFor(btn, expanded) {
    btn.textContent = expanded ? 'Show less' : 'Show more';
    btn.setAttribute('aria-label', expanded ? 'Show less' : 'Show more');
  }
  function currentThreadId() {
    var ws = document.getElementById('thread-workspace');
    if (!ws) return '';
    return (ws.getAttribute('aria-labelledby') || '').replace(/^thread-tab-/, '');
  }
  function compactUserMessages() {
    if (!msgCompactProcessed) return;
    var bubbles = document.querySelectorAll('.msg.user .bubble');
    for (var i = 0; i < bubbles.length; i++) {
      var b = bubbles[i];
      if (msgCompactProcessed.has(b)) continue;
      msgCompactProcessed.add(b);
      if (b.scrollHeight <= 240) continue;
      var key = msgKeyOf(b);
      var expanded = !!(key && msgExpandedSet && msgExpandedSet.has(key));
      b.classList.add(expanded ? 'fb-msg-expanded' : 'fb-msg-collapsed');
      var btn = foldButtonFor(b);
      if (btn) foldLabelFor(btn, expanded);
    }
    syncMsgToggle();
  }
  // Transcript-level control that expands or collapses every long user
  // message at once. It floats at the top-right of the transcript and only
  // shows while the thread has at least one long message. Bulk actions write
  // the same per-message expanded set, so they persist like single expands.
  var msgToggle = null;
  function syncMsgToggle() {
    if (!msgToggle) return;
    // The transcript is virtualizer-managed (foreign children there make
    // React reconcile in a loop), so the toggle floats inside the static
    // thread-bottom region instead. Re-anchor only when the old container
    // was unmounted (thread switch); never re-parent a still-connected node.
    var tb = document.querySelector('.thread-bottom');
    if (tb && !msgToggle.isConnected) tb.appendChild(msgToggle);
    var long = 0;
    var collapsed = 0;
    var bubbles = document.querySelectorAll('.msg.user .bubble');
    for (var i = 0; i < bubbles.length; i++) {
      if (!isLongBubble(bubbles[i])) continue;
      long++;
      if (bubbles[i].classList.contains('fb-msg-collapsed')) collapsed++;
    }
    var want = long ? (collapsed ? 'Expand all' : 'Collapse all') : null;
    if (want !== null) {
      if (msgToggle.style.display !== '') msgToggle.style.display = '';
      if (msgToggle.textContent !== want) msgToggle.textContent = want;
    } else if (msgToggle.style.display !== 'none') {
      // Setting display/textContent is itself a DOM mutation, and the
      // observer below reacts to every childList change; only touch the
      // DOM when the value actually differs or the observer and this scan
      // ping-pong forever.
      msgToggle.style.display = 'none';
    }
  }
  function msgToggleClick() {
    if (!msgToggle) return;
    var expanding = msgToggle.textContent === 'Expand all';
    var tid = currentThreadId();
    var bubbles = document.querySelectorAll('.msg.user .bubble');
    for (var i = 0; i < bubbles.length; i++) {
      var b = bubbles[i];
      if (!isLongBubble(b)) continue;
      var key = msgKeyOf(b);
      var btn = foldButtonFor(b);
      if (expanding) {
        b.classList.remove('fb-msg-collapsed');
        b.classList.add('fb-msg-expanded');
        if (btn) foldLabelFor(btn, true);
        if (key && msgExpandedSet) msgExpandedSet.add(key);
      } else {
        b.classList.add('fb-msg-collapsed');
        b.classList.remove('fb-msg-expanded');
        if (btn) foldLabelFor(btn, false);
        if (key && msgExpandedSet) msgExpandedSet.delete(key);
      }
    }
    if (!expanding && tid && msgExpandedSet) {
      // Drop every saved expansion for this thread, including messages
      // currently scrolled out of the virtualized list.
      var all = Array.from(msgExpandedSet);
      var prefix = tid + ':';
      for (var j = 0; j < all.length; j++) {
        if (String(all[j]).indexOf(prefix) === 0) msgExpandedSet.delete(all[j]);
      }
    }
    saveExpandedMessages();
    syncMsgToggle();
  }
  function bindMessageCompact() {
    if (msgCompactBound) return;
    msgCompactBound = true;
    if (typeof WeakSet !== 'function') return;
    msgCompactProcessed = new WeakSet();
    msgExpandedSet = loadExpandedMessages();
    document.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest && ev.target.closest('.fb-msg-expand');
      if (!btn) return;
      var row = btn.closest && btn.closest('.msg');
      var bubble = row && row.querySelector('.bubble');
      if (!bubble) return;
      var expanding = bubble.classList.contains('fb-msg-collapsed');
      if (expanding) {
        bubble.classList.remove('fb-msg-collapsed');
        bubble.classList.add('fb-msg-expanded');
      } else {
        bubble.classList.add('fb-msg-collapsed');
        bubble.classList.remove('fb-msg-expanded');
      }
      var key = msgKeyOf(bubble);
      if (key && msgExpandedSet) {
        if (expanding) msgExpandedSet.add(key);
        else msgExpandedSet.delete(key);
      }
      foldLabelFor(btn, expanding);
      saveExpandedMessages();
      syncMsgToggle();
    });
    waitForEl('.thread-transcript', function () {
      msgToggle = document.createElement('button');
      msgToggle.type = 'button';
      msgToggle.className = 'fb-msg-toggle';
      msgToggle.setAttribute('aria-label', 'Expand or collapse all long messages');
      msgToggle.style.display = 'none';
      msgToggle.addEventListener('click', msgToggleClick);
      var tb = document.querySelector('.thread-bottom');
      if (tb) tb.appendChild(msgToggle);
      compactUserMessages();
      syncMsgToggle();
      new MutationObserver(function (records) {
        if (!records.some(function (r) { return r.addedNodes && r.addedNodes.length; })) {
          return;
        }
        compactUserMessages();
        syncMsgToggle();
      }).observe(document.body, { childList: true, subtree: true });
    });
  }

  function enterMobile() {
    mobileOverlay.activate();
    scheduleBodySync();
    patchViewport();
    trackViewportHeight();
    collapseExplorerForTouch();
    bindMobileFeatures();
    bindMessageCompact();
    restoreMobileChrome();
    bindFloatLayout();
  }
  function leaveMobile() {
    mobileOverlay.deactivate();
    hideMobileChrome();
    resetFloatLayout();
  }

  // Home catalog (browser port): the app's home screen lists threads for the
  // selected project but never shows WHICH directory a thread lives under.
  // Append a muted directory line under every row — the basename of the
  // selected project chip's path — and keep it in sync while the catalog
  // re-renders (project switch, search, archive toggle). Runs at every
  // viewport: the home page is a first-class surface in the browser port.
  var homeCatalogBound = false;
  function homeCatalogProjectLines() {
    if (homeCatalogBound) return;
    homeCatalogBound = true;
    function apply() {
      var list = document.querySelector('.home-thread-list');
      if (!list) return;
      var sel = document.querySelector('.home-project.selected');
      var path = sel && sel.getAttribute('data-tooltip');
      if (!path) return;
      var parts = path.split(/[\\\\/]/).filter(Boolean);
      var dir = parts.length ? parts[parts.length - 1] : path;
      Array.prototype.forEach.call(
        list.querySelectorAll('.home-thread'),
        function (row) {
          var line = row.querySelector('.fb-thread-project');
          if (!line) {
            line = document.createElement('span');
            line.className = 'fb-thread-project';
            var title = row.querySelector('.home-thread-title');
            (title ? title.parentNode : row).appendChild(line);
          }
          if (line.textContent !== dir) line.textContent = dir;
        },
      );
    }
    watchMobileBody(apply);
    apply();
  }

  // Thread history (mobile home page): the native home catalog only lists the
  // selected project's threads, so add a "Thread history" entry above the
  // search box that opens a full-screen list of EVERY thread across all
  // directories — title, full project path, relative time — with live search, and
  // native click-to-open via the home catalog (openThreadViaHomeCatalog).
  function fetchThreadHistory() {
    return fetch('/api/projects', { headers: { Accept: 'application/json' } })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        var items = [];
        ((data && data.projects) || []).forEach(function (p) {
          (p.threads || []).forEach(function (th) {
            // Catalog threads inherit path from their parent project.
            var record = th &&
              Object.assign({}, th, {
                projectPath: th.projectPath || p.path || p.projectPath || '',
              });
            // Every non-archived session across all directories — including
            // empty "New thread" rows, so the manager can clean them up.
            if (record && !record.archivedAt) {
              items.push(record);
            }
          });
        });
        items.sort(function (a, b) {
          return (
            (b.lastPromptAt || b.updatedAt || 0) -
            (a.lastPromptAt || a.updatedAt || 0)
          );
        });
        return items;
      });
  }
  function dirNameOf(path) {
    var parts = String(path || '').split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(path || '');
  }
  function relativeTime(ts) {
    if (!ts) return '';
    var diff = Date.now() - ts;
    if (diff < 60000) return 'now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h';
    if (diff < 604800000) return Math.floor(diff / 86400000) + 'd';
    var d = new Date(ts);
    return d.getMonth() + 1 + '/' + d.getDate();
  }
  var historyBound = false;
  function homeThreadHistory() {
    if (historyBound) return;
    historyBound = true;
    var boundHomeTab = null;
    var homePollTimer = null;
    function sync() {
      if (!window.matchMedia(MOBILE).matches) return;
      var search = document.querySelector('.home-thread-search');
      var parent = search
        ? search.parentNode
        : document.querySelector('.home-threads');
      if (!parent || parent.querySelector('.fb-history-entry')) return;
      var entry = document.createElement('button');
      entry.type = 'button';
      entry.className = 'fb-history-entry';
      entry.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3.5h10M3 8h10M3 12.5h6"></path></svg><span>Thread history</span>';
      if (search) parent.insertBefore(entry, search);
      else parent.insertBefore(entry, parent.firstChild);
      entry.addEventListener('click', openHistorySheet);
    }
    function pollHome() {
      if (homePollTimer) return;
      var attempts = 0;
      homePollTimer = window.setInterval(function () {
        sync();
        if (document.querySelector('.fb-history-entry') || ++attempts > 40) {
          window.clearInterval(homePollTimer);
          homePollTimer = null;
        }
      }, 80);
    }
    function bindHomeTab() {
      var tab = document.querySelector('.tabbar:not(.threadbar) .tab.home');
      if (!tab || tab === boundHomeTab) return;
      boundHomeTab = tab;
      tab.addEventListener('click', pollHome);
    }
    function refresh() {
      bindHomeTab();
      sync();
    }
    // Home catalog lives inside transcript DOM, which shared body observer
    // intentionally ignores while streaming. Poll after native Home click;
    // bounded wait catches React's delayed catalog mount without observing
    // every streamed token.
    watchMobileBody(refresh);
    waitForEl('.home-threads', refresh);
    refresh();
  }
  var historySheetOpen = false;
  function openHistorySheet() {
    if (historySheetOpen) return;
    historySheetOpen = true;
    var overlay = document.createElement('div');
    overlay.className = 'fb-history-sheet';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Thread history');

    var head = document.createElement('div');
    head.className = 'fb-history-head';
    var title = document.createElement('div');
    title.className = 'fb-history-title';
    title.textContent = 'Thread history';
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'fb-history-close';
    close.setAttribute('aria-label', 'Close thread history');
    close.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"></path></svg>';
    close.addEventListener('click', closeSheet);
    head.appendChild(title);
    head.appendChild(close);
    overlay.appendChild(head);

    var searchBox = document.createElement('input');
    searchBox.type = 'search';
    searchBox.className = 'fb-history-search';
    searchBox.placeholder = 'Search threads';
    searchBox.setAttribute('aria-label', 'Search threads');
    overlay.appendChild(searchBox);

    var list = document.createElement('div');
    list.className = 'fb-history-list';
    overlay.appendChild(list);

    var empty = document.createElement('div');
    empty.className = 'fb-history-empty';
    empty.textContent = 'No threads yet.';

    function closeSheet() {
      historySheetOpen = false;
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
      mobileOverlay.dismiss('thread-history');
    }
    mobileOverlay.open('thread-history', closeSheet);
    attachSwipeDownClose(overlay, closeSheet);

    var lastItems = [];
    function apiCall(id, action, body) {
      return fetch('/api/thread/' + encodeURIComponent(id) + '/' + action, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
    }
    // Inline rename: swap the title line for an input, save on Enter/blur,
    // cancel on Escape. Saved through the same API the native UI uses.
    function beginRename(th, line1) {
      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'fb-history-rename';
      input.value = th.title || '';
      input.setAttribute('aria-label', 'Rename session');
      line1.replaceChildren(input);
      input.focus();
      input.select();
      var done = false;
      function finish(save) {
        if (done) return;
        done = true;
        var title = input.value.trim();
        if (save && title && title !== th.title) {
          apiCall(th.id, 'rename', { title: title })
            .then(function () {
              th.title = title;
              render(lastItems);
              mobileLiveRegion.announce(
                'Session renamed to “' + title + '”.',
                'polite',
              );
            })
            .catch(function () {
              render(lastItems);
              mobileLiveRegion.announce('Could not rename session.', 'polite');
            });
        } else {
          render(lastItems);
        }
      }
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          finish(true);
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          finish(false);
        }
      });
      input.addEventListener('blur', function () {
        finish(true);
      });
      input.addEventListener('click', function (ev) {
        ev.stopPropagation();
      });
    }
    // Delete with confirmation; the sheet stays mounted underneath so No
    // returns to the list. Row removed locally on success.
    function requestDelete(th) {
      var label = th.title || 'New thread';
      deleteSessionConfirm.request(th, function () {
        apiCall(th.id, 'delete', {})
          .then(function () {
            lastItems = lastItems.filter(function (t) {
              return t.id !== th.id;
            });
            if (overlay.parentNode) render(lastItems);
            mobileLiveRegion.announce(
              'Session “' + label + '” deleted.',
              'polite',
            );
          })
          .catch(function () {
            mobileLiveRegion.announce(
              'Session “' + label + '” could not be deleted.',
              'polite',
            );
          });
      }, 'thread-history');
    }
    function render(items) {
      lastItems = items;
      var q = searchBox.value.trim().toLowerCase();
      var shown = 0;
      list.textContent = '';
      items.forEach(function (th) {
        var titleText = th.title || 'New thread';
        var dir = dirNameOf(th.projectPath);
        if (
          q &&
          titleText.toLowerCase().indexOf(q) < 0 &&
          String(th.projectPath || dir).toLowerCase().indexOf(q) < 0
        ) {
          return;
        }
        shown++;
        var row = document.createElement('div');
        row.className = 'fb-history-row';
        row.setAttribute('role', 'button');
        row.tabIndex = 0;
        row.setAttribute('aria-label', 'Open session ' + titleText);
        var line1 = document.createElement('span');
        line1.className = 'fb-history-row-title';
        var titleSpan = document.createElement('span');
        titleSpan.textContent = titleText;
        var time = document.createElement('span');
        time.className = 'fb-history-row-time';
        time.textContent = relativeTime(th.lastPromptAt || th.updatedAt);
        line1.appendChild(titleSpan);
        line1.appendChild(time);
        var line2 = document.createElement('span');
        line2.className = 'fb-history-row-dir';
        line2.textContent = th.projectPath || 'Project path unavailable';
        var actions = document.createElement('div');
        actions.className = 'fb-history-actions';
        var renameBtn = document.createElement('button');
        renameBtn.type = 'button';
        renameBtn.className = 'fb-history-act';
        renameBtn.setAttribute('aria-label', 'Rename session ' + titleText);
        renameBtn.innerHTML =
          '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.3 2.7a1.6 1.6 0 0 1 2.3 2.3L5.5 13.1 2 14l.9-3.5 8.4-7.8z"></path></svg><span>Rename</span>';
        renameBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          beginRename(th, line1);
        });
        var delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'fb-history-act fb-history-act-del';
        delBtn.setAttribute('aria-label', 'Delete session ' + titleText);
        delBtn.innerHTML =
          '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.5h6.6L12 4M6.5 7v4M9.5 7v4"></path></svg><span>Delete</span>';
        delBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          requestDelete(th);
        });
        actions.appendChild(renameBtn);
        actions.appendChild(delBtn);
        row.appendChild(line1);
        row.appendChild(line2);
        row.appendChild(actions);
        row.addEventListener('click', function () {
          closeSheet();
          openThreadViaHomeCatalog(th);
        });
        row.addEventListener('keydown', function (ev) {
          // Enter from the rename input (or buttons) bubbles here — only
          // activate when the row itself is the target.
          if (ev.target !== row) return;
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            closeSheet();
            openThreadViaHomeCatalog(th);
          }
        });
        list.appendChild(row);
      });
      if (!shown) {
        empty.textContent = q ? 'No threads match “' + searchBox.value.trim() + '”.' : 'No threads yet.';
        list.appendChild(empty);
      }
    }

    fetchThreadHistory()
      .then(function (items) {
        if (!overlay.parentNode) return; // closed meanwhile
        render(items);
        searchBox.addEventListener('input', function () {
          render(items);
        });
      })
      .catch(function () {
        if (!overlay.parentNode) return;
        empty.textContent = 'Could not load thread history.';
        list.appendChild(empty);
      });
    document.body.appendChild(overlay);
    close.focus();
  }

  // Copy feedback: the app's copy buttons (referral link, code blocks, and
  // message copy) only swap a subtle label/icon on success. Highlight them
  // with a clear green flash so a successful copy is obvious. The click is
  // watched because the copied state flips a tick or two after the clipboard
  // promise resolves, and the app resets it after ~1-2s.
  var copyFeedbackBound = false;
  function copyFeedback() {
    if (copyFeedbackBound) return;
    copyFeedbackBound = true;
    function sync(btn) {
      if (!btn || !document.contains(btn)) return;
      var copied = false;
      if (btn.classList.contains('referral-copy-btn')) {
        copied = btn.classList.contains('copied');
      } else if (btn.classList.contains('md-copy')) {
        copied = (btn.textContent || '').trim() === 'Copied';
      } else if (btn.classList.contains('msg-copy')) {
        copied = /copied/i.test(btn.getAttribute('aria-label') || '');
      }
      btn.classList.toggle('fb-copied', copied);
    }
    function schedule(btn) {
      [0, 60, 250].forEach(function (ms) {
        setTimeout(function () {
          sync(btn);
        }, ms);
      });
      setTimeout(function () {
        sync(btn);
      }, 2400);
    }
    document.addEventListener(
      'click',
      function (ev) {
        var btn =
          ev.target && ev.target.closest
            ? ev.target.closest('.md-copy, .msg-copy, .referral-copy-btn')
            : null;
        if (btn) schedule(btn);
      },
      true,
    );
  }

  // Ad popup: tapping the sponsored-ad card opens an in-app detail overlay
  // (full copy, destination, CTA) instead of navigating the WebView. Open
  // launches the device's external browser via window.FreebuffNative
  // (Android WebView bridge) or window.open (browser/desktop); Close dismisses.
  // Pi coding-agent panel: a shared Desktop/Mobile surface over the local
  // Pi RPC process. It intentionally uses the existing proxy origin, so the
  // phone never needs a second port or a Pi install of its own.
  var piPanelBound = false;
  function piPanel() {
    if (piPanelBound) return;
    piPanelBound = true;
    waitForEl('body', function () {
      var overlay = null;
      var historyLayer = null;
      var eventSource = null;
      var cwd = '';
      var sessionId = '';
      var session = null;      var sessions = [];
      var messageList = null;
      var sessionList = null;
      var sessionItems = null;
      var piHome = null;
      var piHomeItems = null;
      var DEFAULT_MAP_KEY = 'fb-pi-default-session';
      function defaultSessionMap() {
        try { return JSON.parse(localStorage.getItem(DEFAULT_MAP_KEY) || '{}') || {}; }
        catch (e) { return {}; }
      }
      function getDefaultSession(cwd) {
        var map = defaultSessionMap();
        return Object.prototype.hasOwnProperty.call(map, cwd) ? map[cwd] : '';
      }
      function setDefaultSession(cwd, id) {
        if (!cwd) return;
        var map = defaultSessionMap();
        if (id) map[cwd] = id; else delete map[cwd];
        localStorage.setItem(DEFAULT_MAP_KEY, JSON.stringify(map));
      }
      var sessionDrawerToggle = null;
      var sessionDrawerScrim = null;
      var settingsToggle = null;
      var settingsScrim = null;
      var controls = null;
      var availableProviders = [];
      var promptInput = null;
      var sendButton = null;
      var status = null;
      var projectButton = null;
      var projectLabel = null;
      var scopeSelect = null;
      var modelSelect = null;
      var modelSearch = null;
      var availableModels = [];
      var thinkingSelect = null;
      var wallSelect = null;
      var wallUrl = null;
      var wallApply = null;
      var wallNote = null;
      var streamText = '';
      var streamNode = null;
      var streamThinkingText = '';
      var streamThinkingNode = null;
      var toolCards = Object.create(null);
      var toolArgBuffers = Object.create(null);
      var contentIndexToId = Object.create(null);
      var wallpaperStyleEl = null;
      var wallpaperState = null;
      var WALLPAPER_PRESETS = {
        void: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"%3E%3CradialGradient id="g" cx="50%25" cy="25%25" r="70%25"%3E%3Cstop offset="0%25" stop-color="%232a0a42"/%3E%3Cstop offset="100%25" stop-color="%2305000d"/%3E%3C/radialGradient%3E%3Crect width="128" height="128" fill="url(%23g)"/%3E%3C/svg%3E',
        grid: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"%3E%3Crect width="128" height="128" fill="%2306000d"/%3E%3Cpath d="M0 0h2V128H0zM0 0h128v2H0z" fill="%23140026" fill-opacity=".45"/%3E%3Cg opacity=".35"%3E%3Cpath d="M0 0h1V128H0z"/%3E%3Cpath d="M0 0h128v1H0z"/%3E%3C/g%3E%3C/svg%3E',
        dusk: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"%3E%3ClinearGradient id="g" x1="0%25" y1="0%25" x2="0%25" y2="100%25"%3E%3Cstop offset="0%25" stop-color="%231b0030"/%3E%3Cstop offset="100%25" stop-color="%2304000a"/%3E%3C/linearGradient%3E%3Crect width="128" height="128" fill="url(%23g)"/%3E%3C/svg%3E'
      };
      var promptPending = false;
      var piModeActive = false;
      var piModeToggle = null;
      var piModeTabbar = null;
      var piModeBooted = false;
      var commandLayer = null;
      var slashSuggestionLayer = null;
      var slashSuggestionIndex = 0;
      var PI_SLASH_COMMANDS = [
        ['settings', 'Open settings'],
        ['model', 'Select model'],
        ['models', 'Select model (web alias)'],
        ['scoped-models', 'Choose models for cycling'],
        ['scope-models', 'Choose models for cycling (web alias)'],
        ['export', 'Export session'],
        ['import', 'Import session'],
        ['share', 'Share session'],
        ['copy', 'Copy last agent message'],
        ['name', 'Set session name'],
        ['session', 'Show session info'],
        ['changelog', 'Show changelog'],
        ['hotkeys', 'Show keyboard shortcuts'],
        ['fork', 'Create fork'],
        ['clone', 'Duplicate current session'],
        ['tree', 'Navigate session tree'],
        ['trust', 'Save project trust'],
        ['login', 'Configure provider login'],
        ['logout', 'Remove provider login'],
        ['new', 'Start new session'],
        ['compact', 'Compact session context'],
        ['resume', 'Resume session'],
        ['reload', 'Reload Pi resources'],
        ['quit', 'Close Pi mode'],
      ];

      function piModeStorage(value) {
        try {
          if (value === undefined) return localStorage.getItem('fb-pi-mode') === 'true';
          localStorage.setItem('fb-pi-mode', value ? 'true' : 'false');
        } catch (e) {}
      }
      function nativePiTabs() {
        return piModeTabbar ? Array.prototype.slice.call(piModeTabbar.querySelectorAll('.tab:not(.home), .tab.home, .tab-new')) : [];
      }
      function applyPiModeView() {
        if (!overlay) return;
        overlay.classList.toggle('fb-pi-mode-view', piModeActive);
        if (!piModeActive || !piModeTabbar) {
          overlay.style.top = '';
          overlay.style.bottom = '';
          return;
        }
        var host = overlay.parentElement;
        var tabRect = piModeTabbar.getBoundingClientRect();
        var hostRect = host ? host.getBoundingClientRect() : { top: 0 };
        overlay.style.top = Math.max(0, tabRect.bottom - hostRect.top) + 'px';
        overlay.style.bottom = '0';
      }
      function hideNativePiTabs(hidden) {
        if (!piModeTabbar) return;
        piModeTabbar.querySelectorAll('.tab, .tab-new, .fb-session-switch, .fb-new-session, .fb-mobile-report').forEach(function (node) {
          if (hidden) {
            node.dataset.fbPiModeHidden = 'true';
            node.hidden = true;
          } else if (node.dataset.fbPiModeHidden === 'true') {
            delete node.dataset.fbPiModeHidden;
            node.hidden = false;
          }
        });
      }
      function renderPiModeTabs() {
        if (!piModeTabbar || !piModeActive) return;
        piModeTabbar.querySelectorAll('.fb-pi-mode-tab-wrap, .fb-pi-mode-new, .fb-pi-mode-home-tab').forEach(function (node) { node.remove(); });
        var anchor = piModeTabbar.querySelector('.conn-status, .tabbar-account');
        var home = document.createElement('button');
        home.type = 'button';
        home.className = 'fb-pi-mode-home-tab' + (piHome && !piHome.hidden ? ' active' : '');
        home.textContent = 'Home';
        home.setAttribute('aria-label', 'Open Pi home');
        home.addEventListener('click', showPiHome);
        piModeTabbar.insertBefore(home, anchor);
        var add = document.createElement('button');
        add.type = 'button';
        add.className = 'fb-pi-mode-new';
        add.textContent = '+';
        add.title = 'New Pi session';
        add.setAttribute('aria-label', 'New Pi session');
        add.addEventListener('click', function () { showPiChat(); loadSession(null); });
        piModeTabbar.insertBefore(add, anchor);
        sessions.forEach(function (item) {
          var wrap = document.createElement('span');
          wrap.className = 'fb-pi-mode-tab-wrap';
          var tab = document.createElement('button');
          tab.type = 'button';
          tab.className = 'fb-pi-mode-tab' + (item.id === sessionId ? ' active' : '');
          tab.textContent = historyLabel(item);
          tab.title = historyLabel(item);
          tab.setAttribute('aria-label', 'Open Pi session ' + historyLabel(item));
          tab.addEventListener('click', function () { loadSession(item); });
          var remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'fb-pi-mode-tab-close';
          remove.textContent = '×';
          remove.title = item.id === sessionId ? 'Switch sessions before deleting' : 'Delete session';
          remove.disabled = item.id === sessionId;
          remove.addEventListener('click', function (event) {
            event.stopPropagation();
            deletePiSession(item, remove);
          });
          wrap.appendChild(tab);
          wrap.appendChild(remove);
          piModeTabbar.insertBefore(wrap, anchor);
        });
      }
      function setPiMode(open) {
        piModeActive = !!open;
        piModeStorage(piModeActive);
        if (!piModeTabbar) piModeTabbar = document.querySelector('.tabbar:not(.threadbar)');
        if (piModeToggle) {
          piModeToggle.setAttribute('aria-pressed', String(piModeActive));
          piModeToggle.textContent = piModeActive ? 'Pi' : 'Freebuff';
        }
        hideNativePiTabs(piModeActive);
        if (piModeActive) {
          renderPiModeTabs();
          openPanel();
        } else {
          piModeTabbar && piModeTabbar.querySelectorAll('.fb-pi-mode-tab-wrap, .fb-pi-mode-new, .fb-pi-mode-home-tab').forEach(function (node) { node.remove(); });
          closePanel();
        }
      }
      function ensurePiModeToggle() {
        piModeTabbar = document.querySelector('.tabbar:not(.threadbar)');
        if (!piModeTabbar) return;
        if (!piModeToggle) {
          piModeToggle = document.createElement('button');
          piModeToggle.type = 'button';
          piModeToggle.className = 'fb-pi-mode-toggle';
          piModeToggle.setAttribute('aria-pressed', 'false');
          piModeToggle.addEventListener('click', function () { setPiMode(!piModeActive); });
          var anchor = piModeTabbar.querySelector('.conn-status, .tabbar-account');
          piModeTabbar.insertBefore(piModeToggle, anchor);
        }
        if (!piModeBooted) {
          piModeBooted = true;
          if (piModeStorage()) setPiMode(true);
          else setPiMode(false);
        }
        if (piModeBooted) hideNativePiTabs(piModeActive);
      }

      function savedPiProject() {
        try { return localStorage.getItem('fb-pi-project') || ''; } catch (e) { return ''; }
      }
      function savePiProject(value) {
        try { localStorage.setItem('fb-pi-project', value || ''); } catch (e) {}
      }
      function piProjectPinned() {
        try { return localStorage.getItem('fb-pi-project-pinned') === 'true'; } catch (e) { return false; }
      }
      function pinPiProject(value) {
        savePiProject(value);
        try { localStorage.setItem('fb-pi-project-pinned', 'true'); } catch (e) {}
      }
      function projectValue(project) {
        return project && (project.path || project.projectPath || '');
      }
      function setProjectLabel(value) {
        cwd = value || '';
        if (projectLabel) {
          projectLabel.textContent = cwd || 'Choose directory';
          projectLabel.title = cwd;
          projectLabel.setAttribute('aria-label', 'Working directory ' + (cwd || 'not selected'));
        }
      }
      function projectPath() {
        var active = activeThreadId();
        var saved = savedPiProject();
        return fetch('/api/projects', { headers: { Accept: 'application/json' } })
          .then(function (response) { if (!response.ok) throw new Error('projects'); return response.json(); })
          .then(function (data) {
            var projects = Array.isArray(data && data.projects) ? data.projects : [];
            var found = null;
            projects.some(function (project) {
              var threads = Array.isArray(project.threads) ? project.threads : [];
              if (active && threads.some(function (thread) { return thread && thread.id === active; })) {
                found = project;
                return true;
              }
              return false;
            });
            if (piProjectPinned() && saved) return saved;
            found = found || projects[0];
            return projectValue(found) || saved;
          });
      }
      function switchPiProject(value, selectedSession) {
        var next = String(value || '').trim();
        if (!next) return Promise.resolve(false);
        pinPiProject(next);
        closeEventStream();
        session = null;
        sessionId = '';
        setProjectLabel(next);
        setStatus('Loading sessions…', true);
        return refreshSessions(false).then(function () {
          var chosen = selectedSession && sessions.filter(function (item) { return item.id === selectedSession.id; })[0];
          if (chosen) {
            setDefaultSession(cwd, chosen.id);
            return loadSession(chosen);
          }
          setStatus('Choose Pi session or New', false);
          return true;
        }).then(function () { return true; }).catch(function (error) {
          setStatus(error.message || 'Pi project unavailable', false);
          return false;
        });
      }
      function openPiProjectPicker() {
        var picker = window.freebuffDesktop && window.freebuffDesktop.pickDirectory;
        if (!picker) {
          setStatus('Directory picker unavailable', false);
          return;
        }
        picker().then(function (picked) {
          if (picked) return switchPiProject(picked);
          return false;
        }).catch(function (error) {
          setStatus(error.message || 'Directory picker failed', false);
        });
      }
      function api(pathname, options) {
        return fetch(pathname, options).then(function (response) {
          return response.text().then(function (raw) {
            var payload = {};
            try { payload = raw ? JSON.parse(raw) : {}; } catch (e) { payload = {}; }
            if (!response.ok) throw new Error(payload.message || payload.error || 'pi_request_failed');
            return payload;
          });
        });
      }
      function post(pathname, payload) {
        return api(pathname, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload || {}),
        });
      }
      function closeEventStream() {
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }
      }
      function textOfMessage(message) {
        if (!message) return '';
        if (typeof message.content === 'string') return message.content;
        if (!Array.isArray(message.content)) return '';
        return message.content.filter(function (part) {
          return part && part.type === 'text';
        }).map(function (part) { return part.text || ''; }).join('');
      }
      // Pull tool arguments from whatever field the orchestrator sends.
      function toolArgText(value) {
        if (!value || typeof value !== 'object') return '';
        var keys = ['arguments', 'toolInput', 'input', 'args', 'params', 'parameters'];
        for (var i = 0; i < keys.length; i++) {
          var v = value[keys[i]];
          if (v == null) continue;
          var s = typeof v === 'string' ? v : (function () {
            try { return JSON.stringify(v); } catch (e) { return ''; }
          })();
          s = (s || '').replace(/\s+/g, ' ').trim();
          if (s) return s.slice(0, 240);
        }
        return '';
      }
      function toolCallParts(message) {
        if (!message || !Array.isArray(message.content)) return [];
        return message.content.filter(function (part) {
          return part && part.type === 'toolCall';
        });
      }
      function valueText(value) {
        if (value == null) return '';
        if (typeof value === 'string') return value;
        if (Array.isArray(value)) {
          return value.map(function (part) {
            if (!part || typeof part !== 'object') return String(part || '');
            return part.text || part.result || part.output || part.data || '';
          }).filter(Boolean).join('\n');
        }
        try { return JSON.stringify(value); } catch (e) { return String(value); }
      }
      function toolArgsText(args) {
        if (args == null) return '';
        return (typeof args === 'string' ? args : valueText(args)).replace(/\s+/g, ' ').trim().slice(0, 300);
      }
      function toolSummary(name, args) {
        var label = String(name || 'tool');
        var source = args && typeof args === 'object' ? args : null;
        var path = source && (source.path || source.filePath || source.file || source.filename);
        if (path) return label + ' · ' + String(path).slice(0, 140);
        var compact = toolArgsText(args);
        return compact ? label + ' · ' + compact.slice(0, 100) : label;
      }
      // Fallback summary for tool messages that carry no .content text.
      function toolResultText(message) {
        var t = textOfMessage(message);
        if (t) return t.slice(0, 600);
        var content = message && message.content;
        if (!Array.isArray(content)) return '';
        return content.map(function (p) {
          if (!p || typeof p !== 'object') return '';
          if (p.text) return String(p.text);
          if (p.result != null) return String(p.result);
          if (p.output != null) return String(p.output);
          if (p.data != null) return String(p.data);
          return '';
        }).filter(Boolean).join('\n').slice(0, 600);
      }
      function scrollMessages() {
        if (messageList) messageList.scrollTop = messageList.scrollHeight;
      }
      function addBubble(role, text, extra) {
        if (!messageList) return null;
        var row = document.createElement('article');
        row.className = 'fb-pi-message ' + role + (extra ? ' ' + extra : '');
        var label = document.createElement('div');
        label.className = 'fb-pi-message-role';
        label.textContent = role === 'user' ? 'You' : role === 'assistant' ? 'Pi' : 'Tool';
        var body = document.createElement('div');
        body.className = 'fb-pi-message-body';
        body.textContent = text || '';
        row.appendChild(label);
        row.appendChild(body);
        messageList.appendChild(row);
        scrollMessages();
        return row;
      }
      function addToolCard(name, args, result, toolCallId) {
        if (!messageList) return null;
        var existing = toolCallId && toolCards[toolCallId];
        if (existing) {
          var existingDetail = existing.querySelector('.fb-pi-tool-detail');
          var existingState = existing.querySelector('.fb-pi-tool-state');
          if (result && existingDetail) existingDetail.textContent = result;
          if (result && existingState) existingState.textContent = 'done';
          if (result) existing.classList.remove('pending');
          return existing;
        }
        var row = document.createElement('article');
        row.className = 'fb-pi-message tool fb-pi-tool-card' + (result ? '' : ' pending');
        var toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'fb-pi-tool-toggle';
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-label', 'Expand ' + (name || 'tool') + ' details');
        var caret = document.createElement('span');
        caret.className = 'fb-pi-tool-caret';
        caret.textContent = '▸';
        var summary = document.createElement('span');
        summary.className = 'fb-pi-tool-summary';
        summary.textContent = toolSummary(name, args);
        var state = document.createElement('span');
        state.className = 'fb-pi-tool-state';
        state.textContent = result ? 'done' : 'running';
        toggle.appendChild(caret);
        toggle.appendChild(summary);
        toggle.appendChild(state);
        var detail = document.createElement('div');
        detail.className = 'fb-pi-tool-detail';
        detail.hidden = true;
        detail.textContent = result || '';
        toggle.addEventListener('click', function () {
          var open = toggle.getAttribute('aria-expanded') === 'true';
          toggle.setAttribute('aria-expanded', String(!open));
          detail.hidden = open;
          row.classList.toggle('expanded', !open);
        });
        row.appendChild(toggle);
        row.appendChild(detail);
        messageList.appendChild(row);
        if (toolCallId) toolCards[toolCallId] = row;
        scrollMessages();
        return row;
      }
      function updateToolCard(value, result) {
        var id = value && value.toolCallId;
        var row = id && toolCards[id];
        if (row) {
          var detail = row.querySelector('.fb-pi-tool-detail');
          var state = row.querySelector('.fb-pi-tool-state');
          if (result && detail) detail.textContent = result;
          if (result && state) state.textContent = 'done';
          if (result) row.classList.remove('pending');
          return row;
        }
        return addToolCard(value && value.toolName, value && value.args, result, id);
      }
      function thinkingParts(message) {
        if (!message || !Array.isArray(message.content)) return [];
        return message.content.filter(function (part) { return part && part.type === 'thinking'; });
      }
      function thinkingText(message) {
        return thinkingParts(message).map(function (p) { return p.thinking || ''; }).join('\n\n').trim();
      }
      function addThinkingCard(text) {
        if (!messageList) return null;
        var row = document.createElement('article');
        row.className = 'fb-pi-message tool fb-pi-thinking-card' + (text ? '' : ' thinking');
        var toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'fb-pi-thinking-toggle';
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-label', 'Expand thinking details');
        var caret = document.createElement('span');
        caret.className = 'fb-pi-thinking-caret';
        caret.textContent = '▸';
        var summary = document.createElement('span');
        summary.className = 'fb-pi-thinking-summary';
        summary.textContent = 'Thinking…';
        var state = document.createElement('span');
        state.className = 'fb-pi-thinking-state';
        state.textContent = text ? 'done' : 'thinking';
        toggle.appendChild(caret);
        toggle.appendChild(summary);
        toggle.appendChild(state);
        var detail = document.createElement('div');
        detail.className = 'fb-pi-thinking-detail';
        detail.hidden = true;
        detail.textContent = text || '';
        toggle.addEventListener('click', function () {
          var open = toggle.getAttribute('aria-expanded') === 'true';
          toggle.setAttribute('aria-expanded', String(!open));
          detail.hidden = open;
          row.classList.toggle('expanded', !open);
        });
        row.appendChild(toggle);
        row.appendChild(detail);
        messageList.appendChild(row);
        scrollMessages();
        return row;
      }
      // Accept either {messages:[...]}, {data:{messages:[...]}}, or a raw array.
      function extractMessages(payload) {
        if (Array.isArray(payload)) return payload;
        if (payload && Array.isArray(payload.messages)) return payload.messages;
        if (payload && payload.data) return extractMessages(payload.data);
        return [];
      }
      // Each item may be {message:{role,content}} or a flat {role,content}.
      function normalizeItem(item) {
        if (!item || item.message) return item;
        if (item.role) return { message: item };
        return null;
      }
      function renderMessages(items) {
        if (!messageList) return;
        messageList.textContent = '';
        toolCards = Object.create(null);
        toolArgBuffers = Object.create(null);
        contentIndexToId = Object.create(null);
        streamThinkingNode = null;
        streamThinkingText = '';
        extractMessages(items).forEach(function (raw) {
          var item = normalizeItem(raw);
          if (!item || !item.message) return;
          var message = item.message;
          var role = message.role;
          if (role === 'user') {
            var userText = textOfMessage(message);
            if (userText) addBubble('user', userText);
            return;
          }
          if (role === 'assistant') {
            var assistantThinking = thinkingText(message);
            if (assistantThinking) addThinkingCard(assistantThinking);
            var assistantText = textOfMessage(message);
            if (assistantText) addBubble('assistant', assistantText);
            toolCallParts(message).forEach(function (part) {
              addToolCard(part.name, part.arguments, '', part.id);
            });
            return;
          }
          if (role === 'tool' || role === 'toolResult') {
            addToolCard(message.toolName || message.name || 'tool', '', toolResultText(message), message.toolCallId);
          }
        });
        streamNode = null;
        streamText = '';
      }
      function setStatus(text, busy) {
        if (!status) return;
        status.textContent = text;
        status.classList.toggle('busy', !!busy);
      }
      function handleEvent(value) {
        if (!value) return;
        if (value.type === 'pi_session_state') {
          session = value.session || session;
          var state = value.state || (session && session.state) || 'idle';
          if (state === 'closed') {
            setStatus(value.error === 'pi_idle_timeout' ? 'Idle · send message to resume' : 'Closed · reopen to continue', false);
            closeEventStream();
          } else {
            setStatus(state === 'running' ? 'Running' : state === 'failed' ? 'Failed' : 'Ready', state === 'running');
          }
          return;
        }
        if (value.type === 'agent_start' || value.type === 'turn_start') {
          setStatus('Running', true);
          return;
        }
        if (value.type === 'agent_settled' || value.type === 'agent_end') {
          setStatus('Ready', false);
          refreshSessions(false).catch(function () {});
          return;
        }
        if (value.type === 'message_update' && value.assistantMessageEvent) {
          var update = value.assistantMessageEvent;
          var handled = false;
          if (update.type === 'text_delta' && update.delta) {
            if (!streamNode) streamNode = addBubble('assistant', '', 'streaming');
            streamText += update.delta;
            streamNode.querySelector('.fb-pi-message-body').textContent = streamText;
            scrollMessages();
            handled = true;
          }
          if ((update.type === 'thinking_delta' || update.type === 'reasoning_delta' || update.type === 'thinking') && update.delta) {
            if (!streamThinkingNode) streamThinkingNode = addThinkingCard('');
            streamThinkingText += update.delta;
            var thinkingDetail = streamThinkingNode.querySelector('.fb-pi-thinking-detail');
            if (thinkingDetail) thinkingDetail.textContent = streamThinkingText;
            scrollMessages();
            handled = true;
          } else if (update.thinking && typeof update.thinking === 'string' && update.thinking) {
            if (!streamThinkingNode) streamThinkingNode = addThinkingCard('');
            streamThinkingText += update.thinking;
            var thinkingDetail2 = streamThinkingNode.querySelector('.fb-pi-thinking-detail');
            if (thinkingDetail2) thinkingDetail2.textContent = streamThinkingText;
            scrollMessages();
            handled = true;
          }
          if (update.type === 'thinking_start' || update.type === 'reasoning_start') {
            if (!streamThinkingNode) { streamThinkingNode = addThinkingCard(''); streamThinkingText = ''; }
            handled = true;
          }
          if (update.type === 'thinking_end' || update.type === 'reasoning_end') {
            if (streamThinkingNode) {
              var state = streamThinkingNode.querySelector('.fb-pi-thinking-state');
              if (state) state.textContent = 'done';
              streamThinkingNode.classList.remove('thinking');
            }
            handled = true;
          }
          if (update.type === 'toolcall_start' && typeof update.contentIndex === 'number' && update.id) {
            contentIndexToId[update.contentIndex] = update.id;
            addToolCard(update.toolName || 'tool', '', '', update.id);
            toolArgBuffers[update.contentIndex] = '';
            var startCard = toolCards[update.id];
            if (startCard) {
              var startState = startCard.querySelector('.fb-pi-tool-state');
              if (startState) startState.textContent = 'args…';
              var startDetail = startCard.querySelector('.fb-pi-tool-detail');
              if (startDetail) { startDetail.textContent = ''; startDetail.hidden = false; }
              startCard.classList.add('streaming', 'expanded');
            }
            handled = true;
          }
          if ((update.type === 'toolcall_delta') && typeof update.contentIndex === 'number' && typeof update.delta === 'string') {
            var idx = update.contentIndex;
            toolArgBuffers[idx] = (toolArgBuffers[idx] || '') + update.delta;
            var card = toolCards[contentIndexToId[idx]];
            if (card) {
              var detail = card.querySelector('.fb-pi-tool-detail');
              if (detail && !detail.hidden) detail.textContent = toolArgBuffers[idx];
            }
            handled = true;
          }
          if ((update.type === 'toolcall_end') && typeof update.contentIndex === 'number' && update.toolCall) {
            var id = contentIndexToId[update.contentIndex];
            var endCard = toolCards[id];
            if (endCard) {
              var endState = endCard.querySelector('.fb-pi-tool-state');
              if (endState) endState.textContent = 'pending';
              endCard.classList.remove('streaming');
            }
            delete toolArgBuffers[update.contentIndex];
            delete contentIndexToId[update.contentIndex];
            handled = true;
          }
          if (handled) return;
          return;
        }
        if (value.type === 'message_end' && value.message) {
          if (value.message.role === 'assistant') {
            var finalText = textOfMessage(value.message);
            if (streamNode) {
              if (finalText) streamNode.querySelector('.fb-pi-message-body').textContent = finalText;
              else streamNode.remove();
              streamNode.classList.remove('streaming');
              streamNode = null;
              streamText = '';
            } else if (finalText) {
              addBubble('assistant', finalText);
            }
            var finalThinking = thinkingText(value.message);
            if (streamThinkingNode) {
              if (finalThinking) {
                var thinkingDetail = streamThinkingNode.querySelector('.fb-pi-thinking-detail');
                var thinkingState = streamThinkingNode.querySelector('.fb-pi-thinking-state');
                if (thinkingDetail) thinkingDetail.textContent = finalThinking;
                if (thinkingState) thinkingState.textContent = 'done';
                streamThinkingNode.classList.remove('thinking');
              } else if (streamThinkingText) {
                var thinkingState2 = streamThinkingNode.querySelector('.fb-pi-thinking-state');
                if (thinkingState2) thinkingState2.textContent = 'done';
                streamThinkingNode.classList.remove('thinking');
              } else {
                streamThinkingNode.remove();
              }
              streamThinkingNode = null;
              streamThinkingText = '';
            } else if (finalThinking) {
              addThinkingCard(finalThinking);
            }
            toolCallParts(value.message).forEach(function (part) {
              addToolCard(part.name, part.arguments, '', part.id);
            });
          } else if (value.message.role === 'tool' || value.message.role === 'toolResult') {
            updateToolCard(value.message, toolResultText(value.message));
          }
          return;
        }
        if (value.type === 'tool_execution_start') {
          addToolCard(value.toolName || 'tool', value.args || toolArgText(value), '', value.toolCallId);
          setStatus('Running', true);
          return;
        }
        if (value.type === 'tool_execution_update') {
          updateToolCard(value, valueText(value.partialResult));
          return;
        }
        if (value.type === 'tool_execution_end') {
          updateToolCard(value, valueText(value.result));
          setStatus('Running', true);
        }
      }
      function connectEvents() {
        closeEventStream();
        if (!sessionId) return;
        eventSource = new EventSource('/api/fb/pi/session/' + encodeURIComponent(sessionId) + '/events');
        eventSource.onmessage = function (event) {
          try { handleEvent(JSON.parse(event.data)); } catch (e) {}
        };
        eventSource.onerror = function () {
          if (session && session.state !== 'running') setStatus('Pi connection lost', false);
        };
      }
      function enhancePiSelect(select) {
        if (!select || select.dataset.fbPiEnhanced === 'true') return;
        select.dataset.fbPiEnhanced = 'true';
        var wrap = document.createElement('div');
        wrap.className = 'fb-pi-select-wrap';
        select.parentNode.insertBefore(wrap, select);
        wrap.appendChild(select);
        select.classList.add('fb-pi-native-select');
        select.tabIndex = -1;
        var trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'fb-pi-select-trigger';
        trigger.setAttribute('aria-haspopup', 'listbox');
        trigger.setAttribute('aria-expanded', 'false');
        var menu = document.createElement('div');
        menu.className = 'fb-pi-select-menu';
        menu.setAttribute('role', 'listbox');
        menu.hidden = true;
        wrap.insertBefore(trigger, select);
        wrap.appendChild(menu);
        function close() { menu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); }
        function sync() {
          var option = select.options[select.selectedIndex];
          trigger.textContent = option ? option.textContent : 'Choose…';
          menu.textContent = '';
          Array.prototype.forEach.call(select.options, function (item) {
            var choice = document.createElement('button');
            choice.type = 'button';
            choice.className = 'fb-pi-select-option' + (item.value === select.value ? ' active' : '');
            choice.setAttribute('role', 'option');
            choice.setAttribute('aria-selected', String(item.value === select.value));
            choice.textContent = item.textContent;
            choice.addEventListener('click', function () {
              select.value = item.value;
              select.dispatchEvent(new Event('change', { bubbles: true }));
              close();
              sync();
            });
            menu.appendChild(choice);
          });
        }
        trigger.addEventListener('click', function (event) {
          event.stopPropagation();
          var open = menu.hidden;
          document.querySelectorAll('.fb-pi-select-menu').forEach(function (other) { other.hidden = true; });
          menu.hidden = !open;
          trigger.setAttribute('aria-expanded', String(open));
          sync();
        });
        document.addEventListener('click', function (event) { if (!wrap.contains(event.target)) close(); });
        select.addEventListener('change', sync);
        select._fbPiSync = sync;
        sync();
      }
      function renderAuthProviders() {
        if (!controls) return;
        var select = controls.querySelector('.fb-pi-login-provider');
        if (!select) return;
        var current = select.value;
        var method = controls.querySelector('.fb-pi-login-method');
        var authType = method && method.value === 'account' ? 'oauth' : 'api_key';
        select.textContent = '';
        var matching = availableProviders.filter(function (provider) {
          return !provider.authTypes || provider.authTypes.indexOf(authType) !== -1;
        });
        if (!matching.length) {
          var empty = document.createElement('option');
          empty.value = '';
          empty.textContent = 'No Pi providers found';
          empty.disabled = true;
          empty.selected = true;
          select.appendChild(empty);
        }
        matching.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (provider) {
          var option = document.createElement('option');
          option.value = provider.id;
          var kinds = provider.authTypes && provider.authTypes.length ? provider.authTypes : ['api_key'];
          option.textContent = provider.name + ' (' + provider.id + ') · ' + kinds.join('/');
          option.dataset.authTypes = kinds.join(',');
          select.appendChild(option);
        });
        if (current && Array.from(select.options).some(function (option) { return option.value === current; })) select.value = current;
        if (select._fbPiSync) select._fbPiSync();
      }
      function populateModels(models, providers, authProviders) {
        var providerCatalog = Array.isArray(authProviders) ? authProviders : [];
        var knownById = {};
        providerCatalog.forEach(function (provider) { if (provider && provider.id) knownById[provider.id] = provider; });
        var baseList = Array.isArray(providers) && providers.length
          ? providers
          : Object.keys(knownById);
        availableProviders = baseList.filter(Boolean).map(function (provider) {
          var id = typeof provider === 'string' ? provider : (provider && provider.id);
          var known = knownById[id];
          return {
            id: id,
            name: (known && known.name) || (provider && provider.name) || id,
            authTypes: (known && Array.isArray(known.authTypes) && known.authTypes.length)
              ? known.authTypes.slice()
              : ['api_key'],
          };
        });
        renderAuthProviders();
        availableModels = Array.isArray(models) ? models.filter(function (model) {
          return model && model.provider && model.id;
        }) : [];
        if (scopeSelect) {
          var current = scopeSelect.value || '*';
          scopeSelect.textContent = '';
          var all = document.createElement('option');
          all.value = '*';
          all.textContent = 'All authenticated';
          scopeSelect.appendChild(all);
          Array.from(new Set(availableModels.map(function (model) { return model.provider; }))).sort().forEach(function (provider) {
            var option = document.createElement('option');
            option.value = provider;
            option.textContent = provider;
            scopeSelect.appendChild(option);
          });
          scopeSelect.value = Array.from(scopeSelect.options).some(function (option) { return option.value === current; }) ? current : '*';
        }
        renderModelOptions();
      }
      function renderModelOptions() {
        if (!modelSelect) return;
        var query = modelSearch ? modelSearch.value.trim().toLowerCase() : '';
        var scope = scopeSelect ? scopeSelect.value : '*';
        var current = session && session.model && session.model.provider && session.model.id
          ? session.model.provider + '/' + session.model.id
          : '';
        modelSelect.textContent = '';
        availableModels.filter(function (model) {
          var haystack = String(model.name || model.id).toLowerCase() + ' ' + String(model.provider).toLowerCase();
          return (scope === '*' || model.provider === scope) && (!query || haystack.indexOf(query) >= 0);
        }).forEach(function (model) {
          var option = document.createElement('option');
          option.value = model.provider + '/' + model.id;
          option.textContent = (model.name || model.id) + ' · ' + model.provider;
          modelSelect.appendChild(option);
        });
        if (current && Array.from(modelSelect.options).some(function (option) { return option.value === current; })) {
          modelSelect.value = current;
        }
        if (modelSelect._fbPiSync) modelSelect._fbPiSync();
        if (scopeSelect && scopeSelect._fbPiSync) scopeSelect._fbPiSync();
      }
      function loadSession(item) {
        showPiChat();
        if (promptInput) promptInput.disabled = true;
        if (sendButton) sendButton.disabled = true;
        return post('/api/fb/pi/session/open', { cwd: cwd, sessionId: item && item.id || '' })
          .then(function (payload) {
            session = payload.session;
            sessionId = session.id;
            setDefaultSession(cwd, sessionId);
            setStatus('Loading', true);
            connectEvents();
            return Promise.all([
              api('/api/fb/pi/session/' + encodeURIComponent(sessionId) + '/messages'),
              api('/api/fb/pi/session/' + encodeURIComponent(sessionId) + '/models'),
            ]);
          })
          .then(function (values) {
            renderMessages(values[0]);
            populateModels(values[1].models, values[1].providers, values[1].authProviders);
            // Restore last selected model/thinking (server may not persist them).
            var savedModel = localStorage.getItem('fb-pi-model');
            if (savedModel && Array.from(modelSelect.options).some(function (o) { return o.value === savedModel; })) {
              modelSelect.value = savedModel;
              modelSelect.dispatchEvent(new Event('change'));
            }
            var savedThinking = localStorage.getItem('fb-pi-thinking');
            if (savedThinking && Array.from(thinkingSelect.options).some(function (o) { return o.value === savedThinking; })) {
              thinkingSelect.value = savedThinking;
              thinkingSelect.dispatchEvent(new Event('change'));
            }
            if (promptInput) promptInput.disabled = false;
            if (sendButton) sendButton.disabled = false;
            var current = sessions.filter(function (item) { return item.id === sessionId; })[0];
            if (!current) {
              sessions.unshift({ id: sessionId, cwd: cwd, name: session.name, title: session.name || 'New Pi session', updatedAt: Date.now() });
            }
            setStatus('Ready', false);
            renderSessionList();
          })
          .catch(function (error) {
            if (promptInput) promptInput.disabled = true;
            if (sendButton) sendButton.disabled = true;
            if (item && item.id === getDefaultSession(cwd)) setDefaultSession(cwd, '');
            setStatus(error.message || 'Pi unavailable', false);
          });
      }
      function setSettingsDrawer(open) {
        if (!controls) return;
        if (open) setSessionDrawer(false);
        controls.classList.toggle('settings-open', !!open);
        controls.setAttribute('aria-hidden', String(!open));
        if (settingsScrim) settingsScrim.hidden = !open;
        if (settingsToggle) settingsToggle.setAttribute('aria-expanded', String(!!open));
      }
      function setSessionDrawer(open) {
        if (!sessionList) return;
        if (open) setSettingsDrawer(false);
        sessionList.classList.toggle('drawer-open', !!open);
        sessionList.setAttribute('aria-hidden', String(!open));
        if (sessionDrawerScrim) sessionDrawerScrim.hidden = !open;
        if (sessionDrawerToggle) sessionDrawerToggle.setAttribute('aria-expanded', String(!!open));
      }
      function closeCommandLayer() {
        if (commandLayer && commandLayer.parentNode) commandLayer.parentNode.removeChild(commandLayer);
        commandLayer = null;
      }
      function showCommandNotice(title, message) {
        closeCommandLayer();
        var layer = document.createElement('div');
        layer.className = 'fb-pi-command-layer';
        var card = document.createElement('section');
        card.className = 'fb-pi-command-card';
        card.innerHTML = '<header><strong></strong><button type="button" aria-label="Close command result">×</button></header><p></p><button type="button" class="fb-pi-command-ok">Close</button>';
        card.querySelector('strong').textContent = title;
        card.querySelector('p').textContent = message;
        card.querySelector('header button').addEventListener('click', closeCommandLayer);
        card.querySelector('.fb-pi-command-ok').addEventListener('click', closeCommandLayer);
        layer.appendChild(card);
        layer.addEventListener('click', function (event) { if (event.target === layer) closeCommandLayer(); });
        document.body.appendChild(layer);
        commandLayer = layer;
      }
      function closeSlashSuggestions() {
        if (slashSuggestionLayer && slashSuggestionLayer.parentNode) slashSuggestionLayer.parentNode.removeChild(slashSuggestionLayer);
        slashSuggestionLayer = null;
        slashSuggestionIndex = 0;
      }
      function renderSlashSuggestions() {
        closeSlashSuggestions();
        if (!promptInput || !promptInput.value.trim().startsWith('/')) return;
        var raw = promptInput.value.trim().slice(1);
        if (raw.indexOf(' ') >= 0 || raw.indexOf('\\t') >= 0) return;
        var query = raw.toLowerCase();
        var matches = PI_SLASH_COMMANDS.filter(function (item) { return item[0].indexOf(query) === 0; });
        if (!matches.length) return;
        var layer = document.createElement('div');
        layer.className = 'fb-pi-slash-suggestions';
        matches.forEach(function (item, index) {
          var button = document.createElement('button');
          button.type = 'button';
          button.className = 'fb-pi-slash-suggestion' + (index === 0 ? ' active' : '');
          button.innerHTML = '<strong></strong><span></span>';
          button.querySelector('strong').textContent = '/' + item[0];
          button.querySelector('span').textContent = item[1];
          button.addEventListener('mousedown', function (event) { event.preventDefault(); });
          button.addEventListener('click', function () { runPiSlashCommand(item[0]); });
          layer.appendChild(button);
        });
        promptInput.parentNode.appendChild(layer);
        slashSuggestionLayer = layer;
        slashSuggestionIndex = 0;
      }
      function chooseSlashSuggestion() {
        if (!slashSuggestionLayer) return false;
        var options = slashSuggestionLayer.querySelectorAll('.fb-pi-slash-suggestion');
        var selected = options[slashSuggestionIndex];
        if (!selected) return false;
        var command = selected.querySelector('strong').textContent;
        runPiSlashCommand(command);
        return true;
      }
      function runPiSlashCommand(name, argument) {
        closeSlashSuggestions();
        if (promptInput) promptInput.value = '';
        var command = String(name || '').replace(/^\//, '');
        var args = String(argument || '').trim();
        if (command === 'settings') {
          setSettingsDrawer(true);
          return;
        }
        if (command === 'model' || command === 'models' || command === 'scoped-models' || command === 'scope-models') {
          setSettingsDrawer(true);
          setTimeout(function () {
            var target = command.indexOf('scoped') >= 0 || command.indexOf('scope') >= 0 ? scopeSelect : modelSelect;
            if (target) target.focus();
          }, 0);
          return;
        }
        if (command === 'login') {
          setSettingsDrawer(true);
          var method = controls && controls.querySelector('.fb-pi-login-method');
          var provider = controls && controls.querySelector('.fb-pi-login-provider');
          if (method) { method.value = 'account'; method.dispatchEvent(new Event('change')); }
          if (provider && args && Array.from(provider.options).some(function (option) { return option.value === args; })) provider.value = args;
          if (provider) provider.dispatchEvent(new Event('change'));
          return;
        }
        if (command === 'session' || command === 'resume') {
          setSessionDrawer(true);
          return;
        }
        if (command === 'new') {
          closeCommandLayer();
          loadSession(null);
          return;
        }
        if (command === 'name') {
          var nextName = window.prompt('Pi session name', session && session.name || '');
          if (nextName && sessionId) {
            post('/api/fb/pi/session/' + encodeURIComponent(sessionId) + '/name', { cwd: cwd, name: nextName.trim() })
              .then(function () { return refreshSessions(false); })
              .catch(function (error) { setStatus(error.message || 'Rename failed', false); });
          }
          return;
        }
        if (command === 'compact') {
          if (!sessionId) return;
          var instructions = args || window.prompt('Compaction instructions (optional)', '') || '';
          setStatus('Compacting…', true);
          post('/api/fb/pi/session/' + encodeURIComponent(sessionId) + '/compact', { instructions: instructions })
            .then(function () { setStatus('Compacted', false); return api('/api/fb/pi/session/' + encodeURIComponent(sessionId) + '/messages'); })
            .then(renderMessages)
            .catch(function (error) { setStatus(error.message || 'Compact failed', false); });
          return;
        }
        if (command === 'copy') {
          var messages = messageList ? Array.prototype.slice.call(messageList.querySelectorAll('.fb-pi-message.assistant .fb-pi-message-body')) : [];
          var last = messages.length ? messages[messages.length - 1].textContent : '';
          if (last && navigator.clipboard) navigator.clipboard.writeText(last).then(function () { setStatus('Copied', false); });
          else setStatus('No assistant message to copy', false);
          return;
        }
        if (command === 'quit') {
          setPiMode(false);
          return;
        }
        var detail = PI_SLASH_COMMANDS.filter(function (item) { return item[0] === command; })[0];
        showCommandNotice('/' + command, detail ? detail[1] + '. Use native Pi terminal for this command.' : 'Unknown Pi command.');
      }
      function openPiCommandPalette() {
        if (commandLayer) { closeCommandLayer(); return; }
        var layer = document.createElement('div');
        layer.className = 'fb-pi-command-layer';
        var card = document.createElement('section');
        card.className = 'fb-pi-command-card fb-pi-command-palette';
        var head = document.createElement('header');
        var title = document.createElement('strong');
        title.textContent = 'Pi slash commands';
        var close = document.createElement('button');
        close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', 'Close slash commands');
        close.addEventListener('click', closeCommandLayer);
        head.appendChild(title); head.appendChild(close);
        var search = document.createElement('input');
        search.type = 'search'; search.placeholder = 'Search commands…'; search.setAttribute('aria-label', 'Search Pi slash commands');
        var list = document.createElement('div');
        list.className = 'fb-pi-command-list';
        function render() {
          var query = search.value.trim().toLowerCase();
          list.textContent = '';
          PI_SLASH_COMMANDS.forEach(function (item) {
            if (query && (item[0] + ' ' + item[1]).toLowerCase().indexOf(query) < 0) return;
            var button = document.createElement('button');
            button.type = 'button'; button.className = 'fb-pi-command-item';
            button.innerHTML = '<strong></strong><span></span>';
            button.querySelector('strong').textContent = '/' + item[0];
            button.querySelector('span').textContent = item[1];
            button.addEventListener('click', function () { closeCommandLayer(); runPiSlashCommand(item[0]); });
            list.appendChild(button);
          });
        }
        search.addEventListener('input', render);
        card.appendChild(head); card.appendChild(search); card.appendChild(list); layer.appendChild(card);
        layer.addEventListener('click', function (event) { if (event.target === layer) closeCommandLayer(); });
        document.body.appendChild(layer); commandLayer = layer; render(); search.focus();
      }
      function deletePiSession(item, trigger) {
        if (!item) return Promise.resolve(false);
        if (item.id === sessionId && session && session.state === 'running') {
          setStatus('Stop session before deleting it', false);
          return Promise.resolve(false);
        }
        return new Promise(function (resolve) {
          deleteSessionConfirm.request(item, function () {
            var deletingCurrent = item.id === sessionId;
            if (trigger) trigger.disabled = true;
            if (deletingCurrent) {
              closeEventStream();
              session = null;
              sessionId = '';
              if (promptInput) promptInput.disabled = true;
            }
            api('/api/fb/pi/session/' + encodeURIComponent(item.id) + '/delete?cwd=' + encodeURIComponent(item.cwd || cwd), { method: 'DELETE' })
              .then(function () {
                if (item.id === getDefaultSession(cwd)) setDefaultSession(cwd, '');
                setStatus('Session deleted', false);
                return refreshSessions(false);
              })
              .then(function () { resolve(true); })
              .catch(function (error) {
                if (trigger) trigger.disabled = false;
                setStatus(error.message || 'Delete failed', false);
                resolve(false);
              });
          }, 'pi-session-history');
        });
      }
      function renderSessionList() {
        if (!sessionItems) { renderPiModeTabs(); return; }
        sessionItems.textContent = '';
        var fresh = document.createElement('button');
        fresh.type = 'button';
        fresh.className = 'fb-pi-new-session';
        fresh.textContent = '+ New Pi session';
        fresh.addEventListener('click', function () { setSessionDrawer(false); loadSession(null); });
        sessionItems.appendChild(fresh);
        sessions.forEach(function (item) {
          var row = document.createElement('div');
          row.className = 'fb-pi-session-row';
          var button = document.createElement('button');
          button.type = 'button';
          button.className = 'fb-pi-session' + (item.id === sessionId ? ' active' : '');
          var title = document.createElement('strong');
          title.textContent = item.title || 'Untitled Pi session';
          var meta = document.createElement('span');
          meta.textContent = item.name || new Date(item.updatedAt).toLocaleString();
          button.appendChild(title);
          button.appendChild(meta);
          button.addEventListener('click', function () { setSessionDrawer(false); loadSession(item); });
          var remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'fb-pi-session-delete';
          remove.textContent = '×';
          remove.setAttribute('aria-label', 'Delete ' + historyLabel(item));
          remove.title = item.id === sessionId ? 'Switch sessions before deleting' : 'Delete session';
          remove.disabled = item.id === sessionId;
          remove.addEventListener('click', function (event) {
            event.stopPropagation();
            var wasDefault = item.id === getDefaultSession(cwd);
            deletePiSession(item, remove).then(function (deleted) {
              if (deleted && wasDefault) setDefaultSession(cwd, '');
            });
          });
          row.appendChild(button);
          row.appendChild(remove);
          sessionItems.appendChild(row);
        });
        renderPiModeTabs();
        if (piHome && !piHome.hidden) renderPiHome();
      }
      function closeHistoryManager() {
        if (historyLayer && historyLayer.parentNode) historyLayer.parentNode.removeChild(historyLayer);
        historyLayer = null;
      }
      function historyLabel(item) {
        return item.name || item.title || 'Untitled Pi session';
      }
      function renderHistoryRows() {
        if (!historyLayer) return;
        var list = historyLayer.querySelector('.fb-pi-history-list');
        var search = historyLayer.querySelector('.fb-pi-history-search');
        if (!list) return;
        var query = search ? search.value.trim().toLowerCase() : '';
        list.textContent = '';
        var shown = 0;
        sessions.forEach(function (item) {
          var haystack = [historyLabel(item), item.cwd, item.file].join(' ').toLowerCase();
          if (query && haystack.indexOf(query) < 0) return;
          shown += 1;
          var row = document.createElement('article');
          row.className = 'fb-pi-history-row' + (item.id === sessionId ? ' active' : '');
          row.setAttribute('data-session-id', item.id);
          var info = document.createElement('div');
          info.className = 'fb-pi-history-info';
          var title = document.createElement('strong');
          title.className = 'fb-pi-history-title';
          title.textContent = historyLabel(item);
          var meta = document.createElement('span');
          meta.className = 'fb-pi-history-meta';
          meta.textContent = new Date(item.updatedAt).toLocaleString() + ' · ' + (item.messageCount || 0) + ' messages';
          var pathLabel = document.createElement('span');
          pathLabel.className = 'fb-pi-history-path';
          pathLabel.textContent = item.cwd;
          pathLabel.title = item.cwd;
          info.appendChild(title);
          info.appendChild(meta);
          info.appendChild(pathLabel);
          var actions = document.createElement('div');
          actions.className = 'fb-pi-history-actions';
          var open = document.createElement('button');
          open.type = 'button';
          open.className = 'fb-pi-history-open';
          open.textContent = item.id === sessionId ? 'Selected' : 'Open';
          open.disabled = item.id === sessionId;
          open.addEventListener('click', function () {
            closeHistoryManager();
            loadSession(item);
          });
          var rename = document.createElement('button');
          rename.type = 'button';
          rename.className = 'fb-pi-history-rename';
          rename.textContent = 'Rename';
          rename.addEventListener('click', function () { beginHistoryRename(item, row); });
          var remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'fb-pi-history-delete';
          remove.textContent = item.id === sessionId ? 'Current' : 'Delete';
          remove.disabled = item.id === sessionId;
          remove.title = item.id === sessionId ? 'Switch sessions before deleting' : 'Delete session';
          remove.addEventListener('click', function () {
            var wasDefault = item.id === getDefaultSession(cwd);
            deletePiSession(item, remove).then(function (deleted) {
              if (deleted && wasDefault) setDefaultSession(cwd, '');
            });
          });
          actions.appendChild(open);
          actions.appendChild(rename);
          actions.appendChild(remove);
          row.appendChild(info);
          row.appendChild(actions);
          list.appendChild(row);
        });
        if (!shown) {
          var empty = document.createElement('p');
          empty.className = 'fb-pi-history-empty';
          empty.textContent = query ? 'No Pi sessions match that search.' : 'No Pi sessions in this project.';
          list.appendChild(empty);
        }
      }
      function beginHistoryRename(item, row) {
        var info = row.querySelector('.fb-pi-history-info');
        var actions = row.querySelector('.fb-pi-history-actions');
        if (!info || !actions || row.querySelector('.fb-pi-history-edit')) return;
        info.textContent = '';
        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'fb-pi-history-edit';
        input.maxLength = 120;
        input.value = item.name || '';
        input.placeholder = item.title || 'Session name';
        info.appendChild(input);
        actions.textContent = '';
        var save = document.createElement('button');
        save.type = 'button';
        save.textContent = 'Save';
        var cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.textContent = 'Cancel';
        save.addEventListener('click', function () {
          save.disabled = true;
          api('/api/fb/pi/session/' + encodeURIComponent(item.id) + '/name', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ cwd: item.cwd, name: input.value }),
          }).then(function () {
            return refreshSessions(false);
          }).catch(function (error) {
            save.disabled = false;
            setStatus(error.message || 'Rename failed', false);
          });
        });
        cancel.addEventListener('click', renderHistoryRows);
        actions.appendChild(save);
        actions.appendChild(cancel);
        input.focus();
      }
      function openHistoryManager() {
        if (historyLayer || !overlay) return;
        historyLayer = document.createElement('div');
        historyLayer.className = 'fb-pi-history-layer';
        historyLayer.setAttribute('role', 'dialog');
        historyLayer.setAttribute('aria-modal', 'true');
        historyLayer.setAttribute('aria-labelledby', 'fb-pi-history-title');
        var dialog = document.createElement('section');
        dialog.className = 'fb-pi-history-dialog';
        var head = document.createElement('header');
        head.className = 'fb-pi-history-head';
        var heading = document.createElement('div');
        var title = document.createElement('h3');
        title.id = 'fb-pi-history-title';
        title.textContent = 'Pi session history';
        var scope = document.createElement('span');
        scope.className = 'fb-pi-history-scope';
        scope.textContent = cwd;
        scope.title = cwd;
        heading.appendChild(title);
        heading.appendChild(scope);
        var headActions = document.createElement('div');
        headActions.className = 'fb-pi-history-head-actions';
        var fresh = document.createElement('button');
        fresh.type = 'button';
        fresh.className = 'fb-pi-history-new';
        fresh.textContent = '+ New session';
        fresh.addEventListener('click', function () {
          closeHistoryManager();
          loadSession(null);
        });
        var close = document.createElement('button');
        close.type = 'button';
        close.className = 'fb-pi-history-close';
        close.setAttribute('aria-label', 'Close Pi session history');
        close.textContent = '×';
        close.addEventListener('click', closeHistoryManager);
        headActions.appendChild(fresh);
        headActions.appendChild(close);
        head.appendChild(heading);
        head.appendChild(headActions);
        var search = document.createElement('input');
        search.type = 'search';
        search.className = 'fb-pi-history-search';
        search.placeholder = 'Search sessions…';
        search.setAttribute('aria-label', 'Search Pi session history');
        search.addEventListener('input', renderHistoryRows);
        var list = document.createElement('div');
        list.className = 'fb-pi-history-list';
        dialog.appendChild(head);
        dialog.appendChild(search);
        dialog.appendChild(list);
        historyLayer.appendChild(dialog);
        historyLayer.addEventListener('click', function (event) {
          if (event.target === historyLayer) closeHistoryManager();
        });
        overlay.appendChild(historyLayer);
        renderHistoryRows();
        search.focus();
      }
      function pickInitialSession() {
        var saved = getDefaultSession(cwd);
        if (!saved) return null;
        return sessions.filter(function (s) { return s.id === saved; })[0] || null;
      }
      function refreshSessions(selectFirst) {
        return api('/api/fb/pi/sessions?cwd=' + encodeURIComponent(cwd))
          .then(function (payload) {
            if (payload.cwd && payload.cwd !== cwd) {
              setProjectLabel(payload.cwd);
              savePiProject(payload.cwd);
            }
            sessions = payload.sessions || [];
            renderSessionList();
            renderHistoryRows();
            if (!selectFirst) return null;
            var chosen = pickInitialSession();
            if (chosen) { setDefaultSession(cwd, chosen.id); return loadSession(chosen); }
            if (getDefaultSession(cwd)) setDefaultSession(cwd, '');
            setStatus('Choose session or New', false);
            return null;
          });
      }
      function showPiHome() {
        if (!piHome || !overlay) return;
        if (sessionList) setSessionDrawer(false);
        var chat = overlay.querySelector('.fb-pi-chat');
        if (chat) chat.classList.add('fb-pi-home-active');
        piHome.hidden = false;
        renderPiHome();
        renderPiModeTabs();
      }
      function showPiChat() {
        if (!piHome || !overlay) return;
        piHome.hidden = true;
        var chat = overlay.querySelector('.fb-pi-chat');
        if (chat) chat.classList.remove('fb-pi-home-active');
      }
      function renderPiHome() {
        if (!piHomeItems) return;
        piHomeItems.textContent = '';
        var homeCwd = piHome.querySelector('.fb-pi-home-cwd');
        if (homeCwd) { homeCwd.textContent = cwd || 'No directory selected'; homeCwd.title = cwd; }
        var fresh = document.createElement('button');
        fresh.type = 'button';
        fresh.className = 'fb-pi-home-new';
        fresh.textContent = '+ New Pi session';
        fresh.addEventListener('click', function () { showPiChat(); loadSession(null); });
        piHomeItems.appendChild(fresh);
        if (!sessions.length) {
          var empty = document.createElement('p');
          empty.className = 'fb-pi-home-empty';
          empty.textContent = cwd ? 'No Pi sessions in this directory yet.' : 'Choose directory to begin.';
          piHomeItems.appendChild(empty);
        }
        sessions.forEach(function (item) {
          var row = document.createElement('article');
          row.className = 'fb-pi-home-session' + (item.id === sessionId ? ' active' : '');
          var open = document.createElement('button');
          open.type = 'button';
          open.className = 'fb-pi-home-session-open';
          open.innerHTML = '<strong></strong><span></span>';
          open.querySelector('strong').textContent = historyLabel(item);
          open.querySelector('span').textContent = item.name || new Date(item.updatedAt).toLocaleString();
          open.addEventListener('click', function () { showPiChat(); loadSession(item); });
          var remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'fb-pi-home-session-delete';
          remove.textContent = 'Delete';
          remove.addEventListener('click', function () {
            deletePiSession(item, remove).then(renderPiHome);
          });
          row.appendChild(open);
          row.appendChild(remove);
          piHomeItems.appendChild(row);
        });
      }
      function closePanel() {
        setSessionDrawer(false);
        setSettingsDrawer(false);
        closeEventStream();
        historyLayer = null;
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        overlay = null;
        document.documentElement.classList.remove('fb-pi-active');
      }
      function sendPrompt() {
        if (promptPending || !sessionId || !promptInput) return;
        var text = promptInput.value.trim();
        if (!text) return;
        promptPending = true;
        promptInput.value = '';
        addBubble('user', text);
        if (sendButton) sendButton.disabled = true;
        var reopen = !session || session.state === 'closed';
        var request = Promise.resolve();
        if (reopen) {
          closeEventStream();
          request = post('/api/fb/pi/session/open', { cwd: cwd, sessionId: sessionId })
            .then(function (payload) {
              session = payload.session;
              sessionId = session.id;
              connectEvents();
            });
        }
        request
          .then(function () {
            return post('/api/fb/pi/session/' + encodeURIComponent(sessionId) + '/prompt', { message: text, cwd: cwd });
          })
          .catch(function (error) { addBubble('tool', error.message || 'Prompt failed', 'error'); })
          .finally(function () { promptPending = false; if (sendButton) sendButton.disabled = false; promptInput.focus(); });
      }
      function build() {
        overlay = document.createElement('div');
        overlay.className = 'fb-pi-view';
        var panel = document.createElement('section');
        panel.className = 'fb-pi-panel';
        panel.setAttribute('role', 'region');
        panel.setAttribute('aria-labelledby', 'fb-pi-title');
        var head = document.createElement('header');
        head.className = 'fb-pi-head';
        head.innerHTML = '<div class="fb-pi-heading"><button type="button" class="fb-pi-back" aria-label="Return to Freebuff">←</button><div class="fb-pi-mark">π</div><div><h2 id="fb-pi-title">Pi coding agent</h2><button type="button" class="fb-pi-project-button" aria-label="Choose Pi working directory"><span class="fb-pi-project">Choose directory</span><span class="fb-pi-project-chevron">⌄</span></button><span class="fb-pi-status">Ready</span></div></div>' +
          '<div class="fb-pi-head-actions"><button type="button" class="fb-pi-sessions-toggle" aria-label="Open Pi sessions" aria-expanded="false">Sessions</button><button type="button" class="fb-pi-settings-toggle" aria-label="Open Pi settings" aria-expanded="false">Settings</button><button type="button" class="fb-pi-close" aria-label="Close Pi workspace">×</button></div>';
        status = head.querySelector('.fb-pi-status');
        projectButton = head.querySelector('.fb-pi-project-button');
        projectLabel = head.querySelector('.fb-pi-project');
        projectButton.addEventListener('click', openPiProjectPicker);
        sessionDrawerToggle = head.querySelector('.fb-pi-sessions-toggle');
        settingsToggle = head.querySelector('.fb-pi-settings-toggle');
        head.querySelector('.fb-pi-back').addEventListener('click', closePanel);
        sessionDrawerToggle.addEventListener('click', showPiHome);
        settingsToggle.addEventListener('click', function () {
          setSettingsDrawer(!controls.classList.contains('settings-open'));
        });
        head.querySelector('.fb-pi-close').addEventListener('click', closePanel);
        var body = document.createElement('div');
        body.className = 'fb-pi-body';
        sessionList = document.createElement('aside');
        sessionList.className = 'fb-pi-sessions';
        var sessionHead = document.createElement('div');
        sessionHead.className = 'fb-pi-sessions-head';
        sessionHead.innerHTML = '<strong>Sessions</strong><span>Pi workspace</span><button type="button" class="fb-pi-session-drawer-close" aria-label="Close Pi sessions">×</button>';
        sessionHead.querySelector('.fb-pi-session-drawer-close').addEventListener('click', function () { setSessionDrawer(false); });
        sessionDrawerScrim = document.createElement('button');
        sessionDrawerScrim.type = 'button';
        sessionDrawerScrim.className = 'fb-pi-session-scrim';
        sessionDrawerScrim.setAttribute('aria-label', 'Close Pi sessions');
        sessionDrawerScrim.hidden = true;
        sessionDrawerScrim.addEventListener('click', function () { setSessionDrawer(false); });
        sessionItems = document.createElement('div');
        sessionItems.className = 'fb-pi-session-items';
        sessionList.appendChild(sessionHead);
        sessionList.appendChild(sessionItems);
        var chat = document.createElement('main');
        chat.className = 'fb-pi-chat fb-pi-home-active';
        piHome = document.createElement('section');
        piHome.className = 'fb-pi-home';
        var homeHead = document.createElement('div');
        homeHead.className = 'fb-pi-home-head';
        homeHead.innerHTML = '<div><span class="fb-pi-home-kicker">PI WORKSPACE</span><h3>Choose a session</h3><p class="fb-pi-home-cwd"></p></div><button type="button" class="fb-pi-home-directory">Change directory</button>';
        homeHead.querySelector('.fb-pi-home-directory').addEventListener('click', openPiProjectPicker);
        piHomeItems = document.createElement('div');
        piHomeItems.className = 'fb-pi-home-items';
        piHome.appendChild(homeHead);
        piHome.appendChild(piHomeItems);
        chat.appendChild(piHome);
        messageList = document.createElement('div');
        messageList.className = 'fb-pi-messages';
        controls = document.createElement('div');
        controls.className = 'fb-pi-controls';
        scopeSelect = document.createElement('select');
        scopeSelect.className = 'fb-pi-scope';
        scopeSelect.setAttribute('aria-label', 'Pi model scope');
        var allScope = document.createElement('option');
        allScope.value = '*';
        allScope.textContent = 'All authenticated';
        scopeSelect.appendChild(allScope);
        scopeSelect.addEventListener('change', renderModelOptions);
        modelSearch = document.createElement('input');
        modelSearch.type = 'search';
        modelSearch.className = 'fb-pi-model-search';
        modelSearch.placeholder = 'Search authenticated models…';
        modelSearch.setAttribute('aria-label', 'Search authenticated Pi models');
        modelSearch.addEventListener('input', renderModelOptions);
        modelSelect = document.createElement('select');
        modelSelect.className = 'fb-pi-model';
        modelSelect.setAttribute('aria-label', 'Pi model');
        thinkingSelect = document.createElement('select');
        thinkingSelect.className = 'fb-pi-thinking';
        thinkingSelect.setAttribute('aria-label', 'Pi thinking level');
        ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].forEach(function (level) {
          var option = document.createElement('option');
          option.value = level;
          option.textContent = level;
          thinkingSelect.appendChild(option);
        });
        controls.appendChild(scopeSelect);
        controls.appendChild(modelSearch);
        controls.appendChild(modelSelect);
        controls.appendChild(thinkingSelect);
        var commandLauncher = document.createElement('button');
        commandLauncher.type = 'button';
        commandLauncher.className = 'fb-pi-command-launcher';
        commandLauncher.textContent = 'Slash commands';
        commandLauncher.setAttribute('aria-label', 'Open Pi slash commands');
        commandLauncher.addEventListener('click', openPiCommandPalette);
        controls.appendChild(commandLauncher);
        var authSection = document.createElement('div');
        authSection.className = 'fb-pi-auth';
        var authTitle = document.createElement('strong');
        authTitle.textContent = 'LOGIN';
        var authMethod = document.createElement('select');
        authMethod.className = 'fb-pi-login-method';
        authMethod.setAttribute('aria-label', 'Pi login method');
        var apiOption = document.createElement('option');
        apiOption.value = 'api_key';
        apiOption.textContent = 'Add API key';
        var accountOption = document.createElement('option');
        accountOption.value = 'account';
        accountOption.textContent = 'Pi account login';
        authMethod.appendChild(apiOption);
        authMethod.appendChild(accountOption);
        var authProvider = document.createElement('select');
        authProvider.className = 'fb-pi-login-provider';
        authProvider.setAttribute('aria-label', 'API provider');
        var authKey = document.createElement('input');
        authKey.type = 'password';
        authKey.className = 'fb-pi-login-key';
        authKey.placeholder = 'Paste API key';
        authKey.setAttribute('aria-label', 'API key');
        var authNote = document.createElement('p');
        authNote.className = 'fb-pi-login-note';
        authNote.hidden = true;
        authNote.textContent = 'Pi account login uses subscription OAuth. Run /login in Pi Desktop terminal to complete provider sign-in.';
        var authSave = document.createElement('button');
        authSave.type = 'button';
        authSave.className = 'fb-pi-login-save';
        authSave.textContent = 'Save API key';
        function syncAuthTarget() {
          var account = authMethod.value === 'account';
          var kinds = (authProvider.selectedOptions[0] && authProvider.selectedOptions[0].dataset.authTypes || 'api_key').split(',');
          var keyAllowed = kinds.indexOf('api_key') !== -1;
          authProvider.hidden = false;
          authKey.hidden = account || !keyAllowed;
          authSave.hidden = account || !keyAllowed;
          if (account) {
            authNote.textContent = 'Pi account login uses subscription OAuth. Run /login in Pi Desktop terminal to complete provider sign-in.';
            authNote.hidden = false;
          } else if (!keyAllowed) {
            authNote.textContent = 'This provider uses account login (subscription OAuth), not an API key. Run /login ' + authProvider.value + ' in Pi Desktop terminal.';
            authNote.hidden = false;
          } else {
            authNote.hidden = true;
          }
        }
        authMethod.addEventListener('change', function () { renderAuthProviders(); syncAuthTarget(); });
        authProvider.addEventListener('change', syncAuthTarget);
        authSave.addEventListener('click', function () {
          if (!authProvider.value || !authKey.value.trim()) {
            setStatus('Select provider and enter API key', false);
            return;
          }
          authSave.disabled = true;
          post('/api/fb/pi/auth', { provider: authProvider.value, key: authKey.value.trim() })
            .then(function () {
              authKey.value = '';
              return api('/api/fb/pi/session/' + encodeURIComponent(sessionId) + '/models');
            })
            .then(function (payload) {
              populateModels(payload.models, payload.providers, payload.authProviders);
              setStatus('API key saved', false);
            })
            .catch(function (error) { setStatus(error.message || 'API key save failed', false); })
            .finally(function () { authSave.disabled = false; });
        });
        authSection.appendChild(authTitle);
        authSection.appendChild(authMethod);
        authSection.appendChild(authProvider);
        authSection.appendChild(authKey);
        authSection.appendChild(authNote);
        authSection.appendChild(authSave);
        controls.appendChild(authSection);
        var wallpaperSection = document.createElement('div');
        wallpaperSection.className = 'fb-pi-wallpaper';
        wallpaperSection.style.gridColumn = '1 / -1';
        wallpaperSection.style.display = 'grid';
        wallpaperSection.style.gridTemplateColumns = '100px minmax(0, 1fr) auto';
        wallpaperSection.style.alignItems = 'center';
        wallpaperSection.style.overflow = 'visible';
        wallpaperSection.style.gap = '6px';
        wallpaperSection.style.padding = '6px 8px';
        wallpaperSection.style.borderTop = '1px solid var(--border,#333)';
        var wallTitle = document.createElement('strong');
        wallTitle.textContent = 'WALLPAPER';
        wallTitle.style.fontSize = '10px';
        wallTitle.style.textTransform = 'uppercase';
        wallTitle.style.letterSpacing = '.04em';
        wallTitle.style.color = 'var(--muted,#999)';
        wallSelect = document.createElement('select');
        wallSelect.className = 'fb-pi-wall-select';
        wallSelect.setAttribute('aria-label', 'Wallpaper');
        var wallOptions = [
          ['off', 'Off'],
          ['void', 'Void'],
          ['grid', 'Grid'],
          ['dusk', 'Dusk'],
          ['url', 'URL image…']
        ];
        wallOptions.forEach(function (opt) {
          var o = document.createElement('option');
          o.value = opt[0];
          o.textContent = opt[1];
          wallSelect.appendChild(o);
        });
        wallUrl = document.createElement('input');
        wallUrl.type = 'url';
        wallUrl.className = 'fb-pi-wall-url';
        wallUrl.placeholder = 'https://… .gif/.png/.jpg';
        wallUrl.setAttribute('aria-label', 'Wallpaper image URL');
        wallApply = document.createElement('button');
        wallApply.type = 'button';
        wallApply.className = 'fb-pi-wall-apply';
        wallApply.textContent = 'Apply';
        wallApply.style.minHeight = '26px';
        wallApply.style.fontSize = '10px';
        wallNote = document.createElement('p');
        wallNote.className = 'fb-pi-wall-note';
        wallNote.style.gridColumn = '1 / -1';
        wallNote.style.margin = '4px 0 0';
        wallNote.style.fontSize = '10px';
        wallNote.style.color = 'var(--muted,#999)';
        wallNote.hidden = true;
        wallUrl.hidden = true;
        wallApply.hidden = true;
        wallSelect.addEventListener('change', function () {
          var pick = wallSelect.value;
          if (pick === 'off') {
            wallpaperState = { mode: 'dim', url: '', preset: 'off' };
            applyWallpaper();
            wallUrl.value = '';
            wallNote.hidden = true;
            return;
          }
          if (pick === 'url') {
            wallUrl.hidden = false;
            wallApply.hidden = false;
            wallUrl.focus();
            wallNote.textContent = 'Paste image URL, then Apply.';
            wallNote.hidden = false;
            return;
          }
          // preset
          wallUrl.hidden = true;
          wallApply.hidden = true;
          wallpaperState = { mode: 'dim', url: WALLPAPER_PRESETS[pick] || '', preset: pick };
          applyWallpaper();
          wallNote.textContent = pick + ' wallpaper applied.';
          wallNote.hidden = false;
        });
        wallApply.addEventListener('click', function () {
          var url = wallUrl.value.trim();
          if (!url) { wallpaperState = { mode: 'dim', url: '', preset: 'off' }; wallSelect.value = 'off'; applyWallpaper(); wallNote.hidden = true; return; }
          validateImageUrl(url, function (ok) {
            if (ok) { wallpaperState = { mode: 'dim', url: url, preset: 'url' }; applyWallpaper(); wallNote.textContent = 'Wallpaper applied.'; wallNote.hidden = false; }
            else { wallNote.textContent = 'Image could not be loaded.'; wallNote.hidden = false; }
          });
        });
        wallpaperSection.appendChild(wallTitle);
        wallpaperSection.appendChild(wallSelect);
        wallpaperSection.appendChild(wallUrl);
        wallpaperSection.appendChild(wallApply);
        wallpaperSection.appendChild(wallNote);
        controls.appendChild(wallpaperSection);
        [scopeSelect, modelSelect, thinkingSelect, authMethod, authProvider].forEach(enhancePiSelect);
        settingsScrim = document.createElement('button');
        settingsScrim.type = 'button';
        settingsScrim.className = 'fb-pi-settings-scrim';
        settingsScrim.setAttribute('aria-label', 'Close Pi settings');
        settingsScrim.hidden = true;
        settingsScrim.addEventListener('click', function () { setSettingsDrawer(false); });
        var form = document.createElement('form');
        form.className = 'fb-pi-composer';
        promptInput = document.createElement('textarea');
        promptInput.disabled = true;
        promptInput.rows = 2;
        promptInput.placeholder = 'Ask Pi to work in this project…';
        promptInput.setAttribute('aria-label', 'Message Pi');
        sendButton = null;
        var abortButton = document.createElement('button');
        abortButton.type = 'button';
        abortButton.className = 'fb-pi-abort';
        abortButton.textContent = 'Stop';
        abortButton.addEventListener('click', function () { if (sessionId) post('/api/fb/pi/session/' + encodeURIComponent(sessionId) + '/abort', {}); });
        form.appendChild(promptInput);
        form.appendChild(abortButton);
        chat.appendChild(controls);
        chat.appendChild(messageList);
        chat.appendChild(form);
        body.appendChild(sessionDrawerScrim);
        body.appendChild(sessionList);
        body.appendChild(settingsScrim);
        body.appendChild(chat);
        setSessionDrawer(false);
        setSettingsDrawer(false);
        panel.appendChild(head);
        panel.appendChild(body);
        overlay.appendChild(panel);
        promptInput.addEventListener('input', renderSlashSuggestions);
        promptInput.addEventListener('keydown', function (event) {
          if (slashSuggestionLayer && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            var options = slashSuggestionLayer.querySelectorAll('.fb-pi-slash-suggestion');
            slashSuggestionIndex = (slashSuggestionIndex + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length;
            options.forEach(function (option, index) { option.classList.toggle('active', index === slashSuggestionIndex); });
            return;
          }
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            if (chooseSlashSuggestion()) return;
            var match = promptInput.value.trim().match(/^\/([a-z][a-z-]*)(?:\\s+(.+))?$/i);
            if (match && PI_SLASH_COMMANDS.some(function (item) { return item[0] === match[1].toLowerCase(); })) {
              runPiSlashCommand(match[1], match[2]);
              return;
            }
            sendPrompt();
          }
          if (event.key === 'Escape') closeSlashSuggestions();
        });
        modelSelect.addEventListener('change', function () {
          if (!modelSelect.value) return;
          localStorage.setItem('fb-pi-model', modelSelect.value);
          if (!sessionId) return;
          var split = modelSelect.value.indexOf('/');
          post('/api/fb/pi/session/' + encodeURIComponent(sessionId) + '/model', {
            provider: modelSelect.value.slice(0, split),
            modelId: modelSelect.value.slice(split + 1),
          }).catch(function (error) { setStatus(error.message || 'Model change failed', false); });
        });
        thinkingSelect.addEventListener('change', function () {
          if (!thinkingSelect.value) return;
          localStorage.setItem('fb-pi-thinking', thinkingSelect.value);
          if (sessionId) post('/api/fb/pi/session/' + encodeURIComponent(sessionId) + '/thinking', { level: thinkingSelect.value }).catch(function (error) { setStatus(error.message || 'Thinking change failed', false); });
        });
        return overlay;
      }
      var WALLPAPER_DEFAULT = { mode: 'dim', url: '', preset: 'off' };
      function loadWallpaper() {
        if (!controls) return;
        try { wallpaperState = JSON.parse(localStorage.getItem('fb-pi-wallpaper') || 'null'); } catch (e) { wallpaperState = null; }
        if (!wallpaperState || typeof wallpaperState !== 'object' || !wallpaperState.preset) {
          wallpaperState = WALLPAPER_DEFAULT;
        } else {
          wallpaperState.mode = wallpaperState.mode || 'dim';
          wallpaperState.url = wallpaperState.url || (WALLPAPER_PRESETS[wallpaperState.preset] || '');
        }
        if (wallSelect) wallSelect.value = wallpaperState.preset || 'off';
        var showUrl = wallSelect && wallSelect.value === 'url';
        if (wallUrl) {
          wallUrl.hidden = !showUrl;
          wallUrl.value = showUrl ? (wallpaperState.url || '') : '';
        }
        if (wallApply) wallApply.hidden = !showUrl;
        if (wallNote) wallNote.hidden = true;
        applyWallpaper();
      }
      function persistWallpaper() {
        try { localStorage.setItem('fb-pi-wallpaper', JSON.stringify(wallpaperState || { mode: 'off', url: '' })); } catch (e) {}
      }
      function validateImageUrl(url, cb) {
        try {
          var parsed = new URL(url);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'data:') { cb(false); return; }
        } catch (e) { cb(false); return; }
        var img = new Image();
        img.onload = function () { cb(true); };
        img.onerror = function () { cb(false); };
        img.src = url;
      }
      function applyWallpaper() {
        var state = wallpaperState || { mode: 'off', url: '' };
        var url = state.mode === 'off' ? '' : (state.url || '');
        if (wallpaperStyleEl) wallpaperStyleEl.remove();
        if (!overlay) return;
        if (url) {
          overlay.classList.add('fb-pi-wall');
          overlay.style.setProperty('--fb-wallpaper-dim', state.mode === 'vivid' ? '.14' : '.22');
          wallpaperStyleEl = document.createElement('style');
          wallpaperStyleEl.id = 'fb-pi-wall-style';
          wallpaperStyleEl.textContent =
            '.fb-pi-view.fb-pi-wall { background-image: var(--fb-wallpaper-url) !important; background-size: cover; background-position: center; background-repeat: no-repeat; }' +
            '.fb-pi-view.fb-pi-wall::before { content:""; position:absolute; inset:0; background:rgba(0,0,0,var(--fb-wallpaper-dim,.22)); pointer-events:none; }' +
            '.fb-pi-view.fb-pi-wall .fb-pi-messages, .fb-pi-view.fb-pi-wall .fb-pi-panel, .fb-pi-view.fb-pi-wall .fb-pi-head, .fb-pi-view.fb-pi-wall .fb-pi-home { background: color-mix(in srgb, var(--surface-2,#1a1a1a) 62%, transparent) !important; }' +
            '.fb-pi-view.fb-pi-wall .fb-pi-message { background: color-mix(in srgb, var(--surface-2,#1a1a1a) 58%, transparent) !important; backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px); }' +
            '.fb-pi-view.fb-pi-wall .fb-pi-message.user { background: color-mix(in srgb, var(--fb-pi-accent) 18%, color-mix(in srgb, var(--surface-2,#1a1a1a) 42%, transparent)) !important; }' +
            ':root[data-fb-theme=\'cyberpunk\'] .fb-pi-view.fb-pi-wall .fb-pi-messages, :root[data-fb-theme=\'cyberpunk\'] .fb-pi-view.fb-pi-wall .fb-pi-panel, :root[data-fb-theme=\'cyberpunk\'] .fb-pi-view.fb-pi-wall .fb-pi-head, :root[data-fb-theme=\'cyberpunk\'] .fb-pi-view.fb-pi-wall .fb-pi-home { background: color-mix(in srgb, var(--surface-2,#1a1a1a) 48%, transparent) !important; }' +
            ':root[data-fb-theme=\'cyberpunk\'] .fb-pi-view.fb-pi-wall .fb-pi-message { background: color-mix(in srgb, var(--surface-2,#1a1a1a) 42%, transparent) !important; }';
          document.head.appendChild(wallpaperStyleEl);
          overlay.style.setProperty('--fb-wallpaper-url', 'url("' + url.replace(/"/g, '%22') + '")');
        } else {
          overlay.classList.remove('fb-pi-wall');
          overlay.style.removeProperty('--fb-wallpaper-url');
          overlay.style.removeProperty('--fb-wallpaper-dim');
          wallpaperStyleEl = null;
        }
        persistWallpaper();
      }
      function openPanel() {
        if (overlay) return;
        document.documentElement.classList.add('fb-pi-active');
        overlay = build();
        var host = document.querySelector('.workspace') || document.querySelector('.app') || document.body;
        host.appendChild(overlay);
        applyPiModeView();
        loadWallpaper();
        setStatus('Finding project…', true);
        projectPath().then(function (value) {
          setProjectLabel(value || '');
          if (!cwd) throw new Error('Project path unavailable');
          savePiProject(cwd);
          return refreshSessions(false).then(function () { showPiHome(); });
        }).catch(function (error) { setStatus(error.message || 'Pi unavailable', false); });
      }
      function syncMenus() {
        ensurePiModeToggle();
        document.querySelectorAll('.agent-menu').forEach(function (menu) {
          if (menu.querySelector('.fb-pi-connect')) return;
          var button = document.createElement('button');
          button.type = 'button';
          button.className = 'header-menu-item fb-pi-connect';
          button.setAttribute('role', 'menuitem');
          button.innerHTML = '<span class="fb-pi-menu-icon" aria-hidden="true">π</span><span>Use Pi coding agent</span><small>Sessions, models, and tools</small>';
          button.addEventListener('mousedown', function (event) { event.stopPropagation(); });
          button.addEventListener('click', function (event) {
            event.preventDefault();
            event.stopPropagation();
            menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            setPiMode(true);
          });
          menu.appendChild(button);
        });
      }
      new MutationObserver(syncMenus).observe(document.body, { childList: true, subtree: true });
      syncMenus();
      ensurePiModeToggle();
      window.addEventListener('resize', applyPiModeView);
      document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && overlay) setPiMode(false);
      });
    });
  }

  function bindAdOverlay() {
    // Ad-network redirect hosts (e.g. srv.buysellads.com) are not the real
    // destination and just look like junk in the popup. Hide the destination
    // line when the click target is one of them; the title already names the
    // advertiser.
    var AD_NETWORK_HOSTS = /(^|\.)(buysellads\.com|srv\.buysellads\.com|adzerk\.net|doubleclick\.net|googlesyndication\.com|amazon-adsystem\.com)$/;
    function displayHostOf(url) {
      var host = '';
      try {
        host = new URL(url).hostname.replace(/^www\./, '');
      } catch (e) {
        return '';
      }
      return AD_NETWORK_HOSTS.test(host) ? '' : host;
    }
    function openExternal(url) {
      if (window.FreebuffNative && window.FreebuffNative.openExternal) {
        try {
          window.FreebuffNative.openExternal(url);
          return;
        } catch (e) {
          // fall through to window.open
        }
      }
      window.open(url, '_blank', 'noopener');
    }
    function esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }
    function build(ad) {
      var wrap = document.createElement('div');
      wrap.className = 'fb-ad-overlay';
      var card = document.createElement('div');
      card.className = 'fb-ad-card';
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-modal', 'true');
      card.setAttribute('aria-label', 'Ad');
      card.innerHTML =
        '<div class="fb-ad-card-head">' +
        '<span class="fb-ad-title">' + esc(ad.title || 'Ad') + '</span>' +
        '<button type="button" class="fb-ad-close" aria-label="Close ad">✕</button>' +
        '</div>' +
        '<div class="fb-ad-copy">' + esc(ad.copy || '') + '</div>' +
        (ad.host
          ? '<div class="fb-ad-dest">' + esc(ad.host) + '</div>'
          : '') +
        '<div class="fb-ad-actions">' +
        '<button type="button" class="fb-ad-btn fb-ad-open">Open</button>' +
        '<button type="button" class="fb-ad-btn fb-ad-cancel">Close</button>' +
        '</div>';
      function close() {
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
        document.removeEventListener('keydown', onKey);
      }
      function onKey(ev) {
        if (ev.key === 'Escape') close();
      }
      card.querySelector('.fb-ad-close').addEventListener('click', close);
      card.querySelector('.fb-ad-cancel').addEventListener('click', close);
      card.querySelector('.fb-ad-open').addEventListener('click', function () {
        openExternal(ad.href);
        close();
      });
      wrap.addEventListener('click', function (ev) {
        if (ev.target === wrap) close();
      });
      document.addEventListener('keydown', onKey);
      wrap.appendChild(card);
      return wrap;
    }
    function open(ad) {
      var existing = document.querySelector('.fb-ad-overlay');
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      var wrap = build(ad);
      document.body.appendChild(wrap);
    }
    document.addEventListener('click', function (ev) {
      var anchor =
        ev.target && ev.target.closest
          ? ev.target.closest('.sponsored-ad.ad-banner, .sponsored-ad')
          : null;
      if (!anchor) return;
      ev.preventDefault();
      ev.stopPropagation();
      var title = '';
      var titleEl = anchor.querySelector('.ad-title');
      if (titleEl) title = titleEl.textContent;
      var copy = '';
      var copyEl = anchor.querySelector('.ad-copy');
      if (copyEl) copy = copyEl.textContent;
      var href = anchor.getAttribute('href') || '';
      open({
        title: title,
        copy: copy,
        host: displayHostOf(href),
        href: href,
      });
    });
  }
  bindAdOverlay();
  codexConnect();
  piPanel();

  threadWindowBack();
  browserReloadCleanup();
  homeCatalogProjectLines();
  homeThreadHistory();
  bindMessageCompact();
  sessionSwitcher();
  themePicker();
  copyFeedback();
  var mq = window.matchMedia(MOBILE);
  if (mq.matches) enterMobile();
  watchMedia(mq, function (ev) {
    if (ev.matches) enterMobile();
    else leaveMobile();
  });
})();
