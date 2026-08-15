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
          label: 'Close',
          danger: true,
          action: function () {
            var b = tab.querySelector('.tab-close');
            if (b) b.click();
          },
        },
      ];
      items.forEach(function (it) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'fb-tab-menu-item' + (it.danger ? ' danger' : '');
        b.setAttribute('role', 'menuitem');
        b.textContent = it.label;
        b.addEventListener('click', function (ev) {
          ev.stopPropagation();
          it.action();
          close();
        });
        menu.appendChild(b);
      });
      document.body.appendChild(menu);

      // Swipe down to close (touch only): drag the menu down with the finger;
      // release past the threshold and it animates away, otherwise it snaps
      // back. Uses transitions so the exit matches the open animation.
      var startY = null;
      var startX = null;
      var dragging = false;
      function swipeClose(swiped) {
        startY = null;
        startX = null;
        dragging = false;
        if (!swiped || !menu) return;
        var el = menu;
        menu = null;
        openedTab = null;
        el.style.transition = 'transform 0.12s ease, opacity 0.12s ease';
        el.style.transform = 'translateY(120px)';
        el.style.opacity = '0';
        var done = function () {
          el.remove();
        };
        el.addEventListener('transitionend', done, { once: true });
        setTimeout(done, 200); // safety net
      }
      menu.addEventListener(
        'touchstart',
        function (ev) {
          var t = ev.touches[0];
          startY = t.clientY;
          startX = t.clientX;
          dragging = false;
        },
        { passive: true },
      );
      menu.addEventListener(
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
            menu.style.transform = 'translateY(' + dy + 'px)';
            menu.style.opacity = String(Math.max(0, 1 - dy / 200));
          }
        },
        { passive: false },
      );
      menu.addEventListener('touchend', function () {
        var dy = menu ? (parseFloat((menu.style.transform || '').replace(/[^0-9.-]/g, '')) || 0) : 0;
        if (!dragging) {
          startY = null;
          startX = null;
          return;
        }
        var shouldClose = dy > 60;
        if (menu) {
          menu.style.transform = '';
          menu.style.opacity = '';
        }
        swipeClose(shouldClose);
      });
    }

    // Capture phase so the toggle runs before the app's own click handling.
    document.addEventListener(
      'click',
      function (ev) {
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
    window.addEventListener('scroll', close, true);

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
  }

  // Thread-window (popout) mode: the header is a bare .tabbar.threadbar
  // (title + status) with no tabs, and the browser port has no window
  // controls either. Add a back button that closes the popout and returns
  // focus to the opener — the app itself closes the popout when the active
  // thread is cleared, so closing is the correct "back". React re-renders
  // this header (e.g. connection state), so a MutationObserver re-inserts the
  // button if React ever removes it.
  function threadWindowBack() {
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
          try { window.opener.focus(); } catch (e) {}
        }
        window.close();
        // window.close() is ignored for non-script-opened windows — fall back.
        setTimeout(function () {
          if (!window.closed) { try { history.back(); } catch (e) {} }
        }, 60);
      });
      header.insertBefore(back, header.firstChild);
    }
    ensure();
    new MutationObserver(ensure).observe(header, { childList: true });
  }

  // The popout back button is useful at every viewport (no tabs/window
  // controls in the browser port), so run it unconditionally.
  threadWindowBack();

  var mq = window.matchMedia(MOBILE);
  if (mq.matches) {
    patchViewport();
    trackViewportHeight();
    collapseExplorerForTouch();
  }
  tabTitleMenu();
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
