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
    return !!(
      element &&
      element.closest &&
      element.closest('.messages, .thread-transcript')
    );
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
        floatLayoutMutationObserver = new window.MutationObserver(
          scheduleFloatLayout,
        );
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

  // Session switcher (mobile): the tab strip is hidden on phones (slim
  // header), so switching between open sessions needs a dropdown. A header
  // button opens a menu listing the open session tabs; picking one clicks the
  // app's own .tab-select (native activation). Footer actions reuse the app's
  // .tab-new (new thread) and .tab.home (thread list) buttons.
  var sessionBound = false;
  function sessionSwitcher() {
    if (sessionBound) return;
    sessionBound = true;
    if (!window.matchMedia(MOBILE).matches) return;
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
                // Named, non-archived, with some activity (the home catalog
                // only renders threads that pass its activity check — mirror
                // that so every listed session can actually be opened).
                // Untitled threads carry the literal title "New thread" in
                // the API and would be ambiguous to open by title, so skip
                // them (the home catalog handles those).
                if (
                  th &&
                  th.archivedAt === null &&
                  th.title &&
                  th.title !== 'New thread' &&
                  (th.lastPromptAt || th.branch) &&
                  !open[th.id]
                ) {
                  items.push(th);
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
      // open-thread action → new tab + loadThread).
      function openRecent(th) {
        close();
        var home = tabbar.querySelector('.tab.home');
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
          var expected = Date.now() - (th.lastPromptAt || th.updatedAt || Date.now());
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
            !document.documentElement.contains(menu) ||
            !window.matchMedia(MOBILE).matches
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
            clickNativeTabSelect(tab); // the app's native tab activation
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
            closeSessionConfirm.request(
              tab,
              function () {
                var closed = clickNativeTabClose(tab);
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
            // Two-line row: title on top, project name underneath (basename,
            // same as the app's own project labels) so sessions from
            // different projects are easy to tell apart.
            var main = document.createElement('span');
            main.className = 'fb-session-menu-main';
            var label = document.createElement('span');
            label.className = 'fb-session-menu-label';
            label.textContent = th.title;
            main.appendChild(label);
            var proj = document.createElement('span');
            proj.className = 'fb-session-menu-project';
            var projectPath = th.projectPath || '';
            proj.textContent =
              projectPath.split(/[\\/]/).filter(Boolean).pop() ||
              projectPath ||
              'Project unavailable';
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
      btn.style.display = sessionTabs().length > 0 ? '' : 'none';
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
          close();
        },
        true,
      );

      // React re-renders the tabbar on tab changes: hide the button when no
      // session is open (or the layout widens past mobile). While the menu is
      // open, close it if the active session changed, and refresh it live if
      // sessions opened/closed/reordered (e.g. the per-row close button).
      new MutationObserver(function () {
        if (!window.matchMedia(MOBILE).matches) {
          btn.style.display = 'none';
          close();
          return;
        }
        btn.style.display = sessionTabs().length > 0 ? '' : 'none';
        syncAttention();
        if (menu) renderSessionModelLegend();
        if (!menu) return;
        if (activeTab() !== openedActive) {
          close();
          return;
        }
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
        if (!ev.matches) {
          btn.style.display = 'none';
          close();
        } else {
          btn.style.display = sessionTabs().length > 0 ? '' : 'none';
          syncAttention();
        }
      });
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
            characterData: true,
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
        '.fb-streaming-indicator, .fb-ctx-fab, .fb-panel-toggle, .fb-session-switch, .fb-model-pill, .fb-effort-pill, .fb-time-pill, .fb-composer-pills, .fb-mobile-report',
      )
      .forEach(function (el) {
        el.style.display = 'none';
      });
  }
  function restoreMobileChrome() {
    if (!window.matchMedia(MOBILE).matches) return;
    var composer = !!document.querySelector('.composer');
    var explorer = document.querySelector('.explorer');
    var sessions = document.querySelectorAll(
      '.tabbar:not(.threadbar) .tab:not(.home)',
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
  function enterMobile() {
    mobileOverlay.activate();
    scheduleBodySync();
    patchViewport();
    trackViewportHeight();
    collapseExplorerForTouch();
    bindMobileFeatures();
    restoreMobileChrome();
    bindFloatLayout();
  }
  function leaveMobile() {
    mobileOverlay.deactivate();
    hideMobileChrome();
    resetFloatLayout();
  }

  threadWindowBack();
  browserReloadCleanup();
  var mq = window.matchMedia(MOBILE);
  if (mq.matches) enterMobile();
  watchMedia(mq, function (ev) {
    if (ev.matches) enterMobile();
    else leaveMobile();
  });
})();
