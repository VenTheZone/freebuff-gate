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
 */
(function () {
  'use strict';

  var MOBILE = '(max-width: 900px)';

  function patchViewport() {
    var meta = document.querySelector('meta[name="viewport"]');
    var content =
      'width=device-width, initial-scale=1, viewport-fit=cover, ' +
      'maximum-scale=1, user-scalable=no';
    if (meta) {
      meta.setAttribute('content', content);
    } else {
      meta = document.createElement('meta');
      meta.name = 'viewport';
      meta.content = content;
      document.head.appendChild(meta);
    }
  }

  function trackViewportHeight() {
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
    // Keep clicking every open explorer's toggle until React folds them into
    // the collapsed rail. Handles late React mount + re-renders. ~6s cap.
    var attempts = 0;
    var timer = setInterval(function () {
      var open = document.querySelectorAll('.explorer:not(.collapsed)');
      if (open.length === 0) {
        clearInterval(timer);
        return;
      }
      open.forEach(function (el) {
        var toggle = el.querySelector('.explorer-toggle');
        if (toggle) toggle.click();
      });
      if (++attempts > 50) clearInterval(timer);
    }, 120);
  }

  var mq = window.matchMedia(MOBILE);
  if (mq.matches) {
    patchViewport();
    trackViewportHeight();
    collapseExplorerForTouch();
  }
  // If the device crosses into the narrow layout later (rotation, resize),
  // collapse the explorer then too — but only once per crossing.
  var handled = mq.matches;
  mq.addEventListener('change', function (ev) {
    if (!ev.matches || handled) return;
    handled = true;
    patchViewport();
    trackViewportHeight();
    collapseExplorerForTouch();
  });
})();
