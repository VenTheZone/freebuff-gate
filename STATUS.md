# STATUS — главный источник правды по freebuff-gate

> Этот документ — локальный source of truth для всей работы агента над freebuff-gate.
> Обновлять при КАЖДОМ взаимодействии: что сделано, что сломано, какие решения приняты
> владельцем, что в CI, какой APK реально доходит до юзера. Не полагаться на память.

## Владелец и доступы

- **Основной upstream-репозиторий:** `VenTheZone/freebuff-gate` — **НЕ принадлежит владельцу (youlianvr)**.
  Мёржить туда сам нельзя. PR открывается через **форк `youlianvr/freebuff-gate`** → base `main` upstream.
- **Форк:** `youlianvr/freebuff-gate` (remote `fork`), он же у нас локально.
- **Локальный чек-аут:** `projects/freebuff-gate` (в этом workspace).

## Origin-check — КОСТЫЛЬ, надо убрать

**Реальное положение (проверено 2026-08-25):**

- Origin-проверка `Pairing URL is not from configured Freebuff relay` в `MainActivity.kt`
  (строки ~269-271) в **`main` АКТИВНА**, НО `gradle.properties` в main БЕЗ пина
  (`freebuffPairingOrigin` отсутствует) → `configuredOrigin("")` = null → проверка пропускается.
  **Release из main уже generic и ошибку не даёт.**
- На ветке `feat/file-upload-support` (HEAD `4c531dd`) проверку **закомментировали
  «Origin check disabled for debug builds»** — это КОСТЫЛЬ. Правильно вернуть нормальную
  проверку, а не отключать.
- **Реальный источник ошибки у юзера:** он получал `app-webview-debug.apk` (CI-артефакт джоба
  `debug-apk`), который собирается **С ПИНОМ** `-PfreebuffPairingOrigin=${FB_MOBILE_E2E_RELAY_ORIGIN}`
  (= 10.0.2.2:18495). Пин в дебаге + реальный relay URL ≠ пин → ошибка. Дебаг НЕЛЬЗЯ слать как рабочий.
- **Generic APK (release/gecko)** собирается БЕЗ пина — «Pairs via QR; no baked-in relay origin».
  Его и надо отдавать.

## CI / workflow android.yml

В `projects/freebuff-gate/.github/workflows/android.yml` эти джобы:
- `debug-apk` — собирает **дебаг + пин**, гоняет флаки-эмулятор (succeeds все, падает E2E).
- `gecko-spike` / `relay-integration` — вспомогательные.
- `release-apk` — **`if: github.ref == 'refs/heads/main'`** → только из main. Generic, без пина. Подпись: prod-keystore если секрет, иначе debug-fit.
- `release-gecko-apk` — то же, но gecko-движок.

**Флаки-эмулятор:** E2E-шаг «Run Android instrumentation and relay pairing E2E on API 35 emulator»
падает на раннере (`adb: Unable to connect to daemon`, `The process .../adb failed with exit code 1`).
Из-за `needs: debug-apk` + failure → **`release-apk` и `release-gecko-apk` уходят в skipped**.
Generic APK не доходит. Плюс письмо «что-то фейлнуло» юзеру каждый раз.

> Правило (из ERROR_LOG 2026-08-25): перед отправкой ЛЮБОГО APK проверять (1) какая версия
> (source/version/пин в BuildConfig), (2) status CI (нет ли failed/skipped release). Не «по привычке».

## Что реально раздаётся / куда класть

- Правильный generic APK: **`freebuff-gate-release.apk`** (webview release из main, без пина).
- Локальная копия: `projects/freebuff-gate-dist/freebuff-gate-release.apk` (+ .sha256), 19 авг — может быть устаревшей.
- Релизный тег upstream: `mobile-release-latest` (но форк сверху — релизов ещё не было, проверять каждый раз).

## История активных действий

### 2026-08-25 — PR «mobile-ui restyle»
- Ветка `feat/mobile-ui-restyle` (base origin/main), коммит `64e9112`, PR #2 → VenTheZone.
- Тема: restyle инжектируемого мобильного UI (без эмодзи, без коробок, кастомные dropdown и т.д.).

### 2026-08-25 — вывод про дебаг-пин
- Установлено: юзер всегда получал пинованный дебаг → ошибка pair. Generic только в release/gecko.
- Следующий шаг: сделать generic release доступным и отдать (этот документ надо держать в курсе).

## TODO (следующие шаги)
- [x] 2026-08-25: fork/main синхронизирован с последним origin/main (77b89d8) через `git push fork main --force`.
- [x] 2026-08-25: webview release APK собран, generic без пина, опубликован как `mobile-release-latest`, отправлен в ТГ ЛС.
- [x] 2026-08-25: PR #3 в upstream (VenTheZone) — фикс `working-directory: android` (1 строка).
- [ ] После мержа PR #3: webview release в upstream начнёт собираться; убрать костыль отключения origin-проверки из feat-ветки и вернуть нормальную проверку (обсудить с владельцем).

### 2026-08-25 — webview release собран (фикс CI) + PR #3
- Найден баг upstream-воркфлоу: шаг `Build signed release APK` не имел `working-directory: android`
  → gradle из корня репо падал («does not contain a Gradle build»). gecko-release имел WD — собирался.
- Фикс: +`working-directory: android` (1 строка). Коммит `9d72227`, ветка `fix/release-working-directory`.
- Собран на форке (fork/main = origin/main + фикс, cherry-pick `0acc11f`), run 32896949899:
  `release-apk` success → `mobile-release-latest` → `freebuff-gate-release.apk` (webview, generic без пина; проверено: 10.0.2.2/18495 отсутствуют в dex).
- APK (28.7MB) отправлен в ТГ ЛС (Niko @TheWorld_Machine) со ссылкой на релиз.
- PR #3 → VenTheZone/freebuff-gate: `fix(ci): run webview release build from android/ working dir` (OPEN).

### 2026-09-13 — гигиена форка + аудит + план (согласован владельцем)

**Аудит (факты, не предположения)**
- `main` апстрима заморожен: `9233f04` (2026-08-26), тег `v0.2.1` на нём. 18 дней без коммитов.
- Открыт только наш PR #4; все его раны на апстриме — `action_required` (0 s): GitHub не
  запускает воркфлоу для PR из форка без одобрения мейнтейнера. CI PR #4 ни разу не выполнялся.
- Открыт issue #5 (`lostfromlight`, 04.09): `npm install -g freebuff-gate` → 404. Подтверждено:
  реестр npm отдаёт Not found, корневой `package.json` — `private: true`, а npm-пакеты (`npm/`)
  публикует `setup-binary.yml` за чекбоксом + секретом `NPM_TOKEN`, т.е. не публиковались.
  При этом эту команду советуют README (стр. 215), `docs/install.md`, `npm/README.md`.
- В апстриме есть нативная iOS-версия: `ios/` (13 Swift-файлов). Workflow `iOS build` —
  success на `v0.2.1` (job `build-test`), `signed-ipa` success, `attach-release` skipped.
- Вечно-красные воркфлоу (красные и на апстриме):
  - `Commit identity` — требует, чтобы КАЖДЫЙ коммит в `git log --all` был
    `venthezone <kytusdevenn@gmail.com>`; в истории апстрима уже 5 коммитов не от него → неисполним.
  - `Mobile UI screenshot regression` — ассерт
    `refreshed model session availability missing from Chromium accessibility tree`.
    Тест крутит ФИКСТУРУ из репо через `createProxyServer`, живой Desktop не участвует.

**Дрейф Desktop: репо знает 0.0.71, установлен 0.0.110 (обновлён 2026-09-13 08:46)**
- `patchBundleInfo` на `ui/assets/index-DVP89Kth.js` → `changed: false`, `obsolete: []`,
  `warnings: []`. Все 11 якорей (`CREATE_MARK`, `SETSTATE_MARK`, `SCROLL_MARK`, `CLOSE_MARK1-3`,
  `CLOSE_BTN_MARK`, `OPEN_THREAD_MARK`, `SKILL_ORIGIN_MARK`) — miss. Патчи бандла мертвы, молча.
- `checkUiPatches` при этом рапортует `verify OK: 0 error(s), 1 warning(s)` → watchdog слепой.
- В установленном `orchestrator.js` 0.0.110 нет ни одного `/api/fb/*` маршрута (патч смыт апдейтом).
- Прокси сам отдаёт `upload`, `read-file`, `perf-report`, `last-ad`, `ui-patch-status`,
  а `dirlist` только зовёт (стр. 496) и проверяет (стр. 1010) → папка-пикер 404.

**Сделано (гигиена форка)**
- Бэкап-тег `fork/main-pre-clean` → `fe30769` (в форке).
- `fork/main` пересобран: `origin/main` + ровно 4 коммита PR #4 (`fac8b52`, `db0f38a`,
  `0d3a5f9`, `10e34f2`). Ушли лишний merge и `0acc11f` (патч-эквивалент влитого `9d72227`).
- Remote-ветка `feat/file-upload-support` удалена; перед удалением заархивирована тегом
  `archive/feat-file-upload-support` (`b66887b`).
- На форке осталось ровно две ветки: `main` и `feat/mobile-ui-fixes`, обе на `10e34f2`.

**Согласованные решения владельца**
- Identity: allowlist по email — `kytusdevenn@gmail.com`, `youlianvr@gmail.com`,
  `youlianvr2@gmail.com`, `noreply@github.com` (имена не сравнивать: в истории разные).
- fork/main — убрать мусор (сделано).
- iOS — планка «CI зелёный + паритет фич в коде»; реальный прогон на устройстве вне нашей машины.
- Планка готовности: все документированные фичи gate на 0.0.110 + прогон на планшете.
- PR не создавать и не пушить без отдельного разрешения владельца.

### 2026-09-14 — dirlist в прокси + честный watchdog + Windows-фиксы (адаптация под 0.0.110)

**Windows-фейлы тест-набора (6 шт) — починены, набор полностью зелёный (157 тестов, 0 fail):**
- `parseArgs`/SEA-конфиг: тесты ждали литеральные POSIX-пути; теперь сравнивают с path-resolved формой.
- installer-тест: launcher-скрипт не спавнится из execFileSync на win32 → гоняем node-обёртку; darwin auto-start требует `options.uid` → задан.
- tar: GNU tar трактует `C:\...` как remote-host → архивы создаются/читаются по относительному пути с `cwd`.
- npm: на win32 это `npm.cmd`, spawnSync без shell отказывается (CVE-2024-27980) → `shell: true` на win32.
- Коммиты: `844cd20`, `156be79`, `fb1e8b2`.

**dirlist перенесён в tailnet-прокси (`be7f161`):**
- Прокси отвечает на `GET /api/fb/dirlist?path=...` сам (тот же wire shape: `{path, entries:[{name,dir}]}`, dirs-first сортировка; 400 с текстом ошибки на битый путь).
- Инсталлерский route-block больше НЕ вставляет dirlist в orchestrator.js; stale-block upgrade глотает легаси-dirlist-ветку; verify не требует dirlist в оркестраторе.
- Live-проверка: `:58061/api/fb/dirlist` → 200 с записями; папка-пикер переживает апдейты Desktop.

**Якорь роутов переведён на regex (`50c0d8e`):**
- 0.0.110 переименовал минифицированный счётчик `match12` → `match14`; литеральный якорь ломался каждым апдейтом. Теперь якорь — `upgrade required` + `findRoute` dispatch (любой счётчик). Тест-фикстура с match14 зелёная.

**Watchdog честный (`be7f161`):**
- `patchBundleInfo` возвращает `recognized`: «неизвестное поколение бандла» больше не неотличимо от «здорового».
- `checkUiPatches`: unknown generation → ERROR с перечислением пропущенных патчей («derive new anchors for this Desktop version»).
- dirlist больше не пробуется upstream (он локальный); perf-report пробуется (on-disk).
- Live-статус на 0.0.110 теперь ЧЕСТНЫЙ `ok: false` с тремя ошибками (shim on raw upstream, unknown bundle generation, perf-report route) вместо прежнего лживого «OK».

**Применено к установленному окружению:**
- `orchestrator.js` 0.0.110: route-block (perf-report+upload+read-file, без dirlist) применён, bun build OK. Бэкап `orchestrator.js.gate-bak-20260914-dirlist`. ВАЖНО: bun-процесс Desktop (pid 14980) стартовал ДО патча — подхватит после рестарта Desktop.
- Прокси: репо-копия задеплоена в `AppData/Local/Freebuff/tailnet-proxy/freebuff_tailnet_proxy.js` (бэкап `.bak-20260914-dirlist`), рестартнута с `FREEBUFF_UPSTREAM=127.0.0.1:47800`, `FREEBUFF_PROXY_HOST=0.0.0.0` (pid живой, `:58061` listening).

**Открытые проблемы (не блокер, зафиксированы):**
- Watchdog-fail на raw upstream по shim/perf-report — ожидаемо до переустановки ui-стека инсталлером (on-disk shim смыт апдейтом 0.0.110; реальный сервинг прокси shim инжектит — живая страница содержит fb-desktop-shim).
- Неизвестно, откуда discovery-скрипт берёт порт: `discover-orchestrator.ps1` отсутствует в репо (`DISCOVER_SCRIPT` указывает на `__dirname`); в деплой-каталоге он есть. Прокси стартует с явным `FREEBUFF_UPSTREAM` — не блокер, но чинить при случае.
- Bundle-патчи (CREATE/SETSTATE/CLOSE/OPEN_THREAD/SKILL) на 0.0.110 мертвы — нужны новые якоря под новое поколение бандла (отдельная задача).

**Дополнение 2026-09-14 (CI):** identity-check падал не по виновным — `>-` (folded scalar)
склеивал allowlist в одну строку, и `grep -qxF` (fixed, whole-line) отвергал даже одобренные
email. Фикс: блочный `|` (`e55ce76`). Прогон на `main` — success. Screenshot regression на
`main` — success. Android build — in_progress.

### 2026-09-14 — CI-итоги на свежем push (0eb61eb) + фикс iOS attach-release

**Все воркфлоу на `main` форка — зелёные:**
- `Commit identity` — success (после фикса `|`-скаляра).
- `Mobile UI screenshot regression` — success.
- `Android build and release` — success: все 5 джоб (debug-apk, release-apk, release-gecko-apk, relay-integration, gecko-spike). Первый прогон debug-apk упёрся в 50-минутный таймаут джоба на шаге emulator-E2E (флак-эмулятор, известная история), реран прошёл за 7 минут — весь пайплайн success.
- `iOS build` — success: build-test, signed-ipa, **attach-release**.

**Фикс iOS attach-release (`0eb61eb`):** джоба падала, потому что upload-artifact v4 при
загрузке одиночного каталога сохраняет его СОДЕРЖИМОЕ в корень артефакта (проверено
скачиванием артефакта: Info.plist/Frameworks/PlugIns в корне, каталога FreebuffGate.app нет).
`find -name 'FreebuffGate.app' -type d` не находил ничего → exit 1. Фикс: стадируем содержимое
артефакта в `$RUNNER_TEMP/staged/FreebuffGate.app/` и зипуем оттуда; guard `test -f Info.plist`.

**PR #4** (VenTheZone/freebuff-gate#4): описание обновлено (полный список из 18 коммитов),
head = `0eb61eb`... хвост синка после iOS-фикса — перепроверить, что PR-ветка = форк/main,
mergeStateStatus был CLEAN, все чеки (кроме ожидаемых skipped release-джоб) — SUCCESS.
