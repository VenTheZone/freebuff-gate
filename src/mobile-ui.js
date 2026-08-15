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

  var MOBILE = '(max-width: 900px)';

  // Accessibility: on-demand larger chat text, persisted per device. Applied
  // on every page (including popouts) before the app paints, so no flash.
  var root = document.documentElement;
  var TEXT_KEY = 'fb-ui:text-large';
  try {
    if (localStorage.getItem(TEXT_KEY) === '1') {
      root.classList.add('fb-text-large');
    }
  } catch (e) {}

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
      if (!document.body) return; // wait for React to mount the explorer
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
      var observer = new MutationObserver(function () {
        var narrow = window.matchMedia('(max-width: 700px)').matches;
        var menu = document.querySelector('.composer-context .agent-menu');
        if (!menu || !narrow) {
          if (closeBtn) {
            closeBtn.remove();
            closeBtn = null;
          }
          return;
        }
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
        closeBtn.addEventListener('click', function () {
          if (menu && document.contains(menu)) {
            menu.dispatchEvent(
              new KeyboardEvent('keydown', {
                key: 'Escape',
                bubbles: true,
                cancelable: true,
              }),
            );
          }
        });
        document.body.appendChild(closeBtn);
      });
      observer.observe(document.body, { childList: true, subtree: true });
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
            close();
          });
          menu.appendChild(b);
        });
        document.body.appendChild(menu);
        attachSwipeDownClose(menu, function () {
          if (menu) {
            menu.remove();
            menu = null;
            openedTab = null;
          }
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
      function close() {
        if (menu) {
          menu.remove();
          menu = null;
          openedActive = null;
        }
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

        if (tabs.length === 0) {
          var empty = document.createElement('div');
          empty.className = 'fb-session-menu-empty';
          empty.textContent = 'No open sessions';
          menu.appendChild(empty);
        }
        tabs.forEach(function (tab) {
          var active = tab.classList.contains('active');
          var row = document.createElement('div');
          row.className = 'fb-session-menu-item' + (active ? ' active' : '');

          // Select area: switches to this session via the app's own
          // .tab-select activation.
          var sel = document.createElement('button');
          sel.type = 'button';
          sel.className = 'fb-session-menu-select';
          sel.setAttribute('role', 'menuitemradio');
          sel.setAttribute('aria-checked', String(active));
          var label = document.createElement('span');
          label.className = 'fb-session-menu-label';
          label.textContent = titleOf(tab);
          sel.appendChild(label);
          if (active) {
            var check = document.createElement('span');
            check.className = 'fb-session-menu-check';
            check.setAttribute('aria-hidden', 'true');
            check.textContent = '\u2713';
            sel.appendChild(check);
          }
          sel.addEventListener('click', function () {
            var tsel = tab.querySelector('.tab-select');
            if (tsel) tsel.click(); // the app's native tab activation
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
            var x = tab.querySelector('.tab-close');
            if (x) x.click(); // the app's native tab close
          });
          row.appendChild(closeBtn);

          menu.appendChild(row);
        });

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
            proj.textContent =
              th.projectPath.split(/[\\/]/).filter(Boolean).pop() ||
              th.projectPath;
            main.appendChild(proj);
            b.appendChild(main);
            var time = document.createElement('span');
            time.className = 'fb-session-menu-time';
            time.textContent = relTime(th.lastPromptAt || th.updatedAt);
            b.appendChild(time);
            b.addEventListener('click', function () {
              openRecent(th);
            });
            recentList.appendChild(b);
          });
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
        attachSwipeDownClose(menu, function () {
          if (menu) {
            menu.remove();
            menu = null;
            openedActive = null;
          }
        });
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
      window.addEventListener('scroll', close, true);

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
        if (!menu) return;
        if (activeTab() !== openedActive) {
          close();
          return;
        }
        var now = tabIds().join('\u0000');
        if (openedIds && now !== openedIds.join('\u0000')) open();
      }).observe(tabbar, { childList: true, subtree: true });
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
      function sync() {
        if (!window.matchMedia(MOBILE).matches) {
          btn.style.display = 'none';
          removeScrim();
          return;
        }
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
        if (ev.key === 'Escape') closePanel();
      });
      // React re-renders constantly; class changes on the explorer (open /
      // collapsed) plus its mount/unmount are enough to keep scrim + button
      // in sync.
      new MutationObserver(sync).observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
      });
      sync();
    });
  }

  // Composer context chips (agent/model/effort/workspace) collapse into a
  // floating button on mobile so the composer stays clean (see
  // mobile-ui.css). Tapping the button pops the chips up as a floating card
  // above the composer; outside tap, Escape, scroll, or resize dismisses it.
  var ctxBound = false;
  function composerCtx() {
    if (ctxBound) return;
    ctxBound = true;
    if (!window.matchMedia(MOBILE).matches) return;
    waitForEl('.composer', function () {
      var composer = document.querySelector('.composer');
      if (!composer) return;

      var fab = null;
      var popupEl = null;
      var closingTimer = null;
      function isOpen() {
        return root.classList.contains('fb-ctx-open');
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
          'stroke-linejoin="round"><path d="M4 9.5 8 5.5l4 4"/></svg>';
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
        fab.classList.toggle('open', open);
        fab.setAttribute('aria-expanded', String(open));
      }
      function open() {
        clearTimeout(closingTimer);
        if (popupEl) popupEl.classList.remove('fb-ctx-closing');
        root.classList.add('fb-ctx-open');
        popupEl = composer.querySelector('.composer-context');
        syncFab();
      }
      function finishClose() {
        clearTimeout(closingTimer);
        root.classList.remove('fb-ctx-open');
        if (popupEl) popupEl.classList.remove('fb-ctx-closing');
        popupEl = null;
        syncFab();
      }
      function close() {
        if (!isOpen()) return;
        popupEl = composer.querySelector('.composer-context');
        syncFab(); // chevron flips down while the card slides away
        if (!popupEl) {
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
              var a = composer.querySelector('.composer-row .attach');
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
            var k = composer.querySelector('.composer-row .stash-key');
            if (k) k.click();
          },
        );
        wrap.appendChild(stashBtn);
        stopBtn = actionBtn(
          'stop',
          'Stop the running turn',
          '<rect x="4" y="4" width="16" height="16" rx="3"/>',
          function () {
            var s = composer.querySelector('.composer-row .stop');
            if (s) s.click();
          },
        );
        wrap.appendChild(stopBtn);
        sendBtn = actionBtn(
          'send',
          'Send message',
          '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
          function () {
            var s = composer.querySelector('.composer-row .send-key');
            if (s) s.click();
          },
        );
        wrap.appendChild(sendBtn);
        return wrap;
      }
      function syncActions() {
        if (!actions) return;
        var row = composer.querySelector('.composer-row');
        if (!row) return;
        stopBtn.style.display = row.querySelector('.stop') ? '' : 'none';
        stashBtn.style.display = row.querySelector('.stash-key') ? '' : 'none';
        sendBtn.classList.toggle(
          'ready',
          !!row.querySelector('.send-key.ready'),
        );
      }

      fab = makeFab();
      composer.appendChild(fab);
      actions = makeActions();

      // React re-renders the composer and can wipe injected elements —
      // re-insert the fab and the action bar (with current state), and keep
      // the stop/stash/send state in sync with the app's own buttons.
      new MutationObserver(function () {
        if (!composer.contains(fab)) {
          fab = makeFab();
          composer.appendChild(fab);
        }
        var card = composer.querySelector('.composer-context');
        if (card && !card.contains(actions)) {
          card.appendChild(actions);
        }
        syncActions();
      }).observe(composer, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
      });
      syncActions();

      document.addEventListener(
        'click',
        function (ev) {
          if (!isOpen()) return;
          var popup = composer.querySelector('.composer-context');
          if (popup && popup.contains(ev.target)) return;
          if (fab && fab.contains(ev.target)) return;
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
        if (ev.key === 'Escape') close();
      });
      window.addEventListener('resize', close);
      window.addEventListener('scroll', close, true);
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

  // Bind everything. DOM-dependent features wait internally (waitForEl) for
  // React to mount; the pure-<head> pieces run immediately.
  threadWindowBack();
  var mq = window.matchMedia(MOBILE);
  if (mq.matches) {
    patchViewport();
    trackViewportHeight();
    collapseExplorerForTouch();
  }
  tabTitleMenu();
  modelSheet();
  sessionSwitcher();
  sidePanel();
  composerCtx();
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
