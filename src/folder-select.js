/**
 * folder-select.js — the folder-selection tweak for the Freebuff Desktop
 * browser port.
 *
 * Desktop (Electron) can pop a native folder dialog; a browser cannot.
 * This module reproduces folder selection in the browser:
 *
 *   1. `window.showDirectoryPicker()` — File System Access API (Chromium,
 *      Edge). It MUST be called synchronously inside a user gesture: do not
 *      `await` anything before calling it, or the browser drops user
 *      activation and rejects with `SecurityError`. This is the #1 gotcha
 *      this tweak exists to prevent.
 *   2. Pass `{ id }` to the picker so Chromium remembers the last-picked
 *      folder and re-selects it next time (restoreLastFolder) — no paths
 *      stored, since browsers refuse to expose real absolute paths.
 *   3. Persist the DirectoryHandle in IndexedDB and re-request permission
 *      with `handle.requestPermission({ mode })` on reload, because handles
 *      do not auto-grant permission across sessions.
 *   4. Fall back to `<input type="file" webkitdirectory>` when the File
 *      System Access API is unavailable (Firefox/Safari). Read-only and
 *      session-scoped.
 *   5. Expose a stable synthetic "virtual path" (e.g. `workspace://name`)
 *      in the UI instead of an absolute path.
 *
 * Wire it up: pass the `folderSelection` block from `.fb-browser-ui.json`
 * into `pickFolder()` / `restoreLastFolder()`.
 */

const DEFAULTS = {
  mode: "showDirectoryPicker",
  fallbackMode: "webkitdirectory",
  pickerId: "fb-workspace",
  permissionMode: "readwrite",
  persistHandles: true,
  reRequestPermissionOnReload: true,
  restoreLastFolder: true,
  virtualPaths: true,
};

const IDB_NAME = "fb-browser-ui";
const IDB_STORE = "folderHandles";
const HANDLE_KEY = "workspace";

export function resolveConfig(overrides = {}) {
  return { ...DEFAULTS, ...overrides };
}

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Fallback picker: hidden <input webkitdirectory> returning a FileList. */
function pickViaInput() {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");
    input.setAttribute("multiple", "");
    input.style.display = "none";
    input.addEventListener("change", () => {
      input.remove();
      resolve(input.files);
    });
    input.addEventListener("cancel", () => {
      input.remove();
      resolve(null);
    });
    document.body.appendChild(input);
    input.click();
  });
}

/**
 * THE TWEAK, core entry point. Call this directly from a click handler.
 * If the user cancels, resolves null. Rejects only on hard failures.
 */
export async function pickFolder(config = resolveConfig()) {
  const hasFSA = typeof window !== "undefined" && "showDirectoryPicker" in window;

  if (config.mode === "showDirectoryPicker" && hasFSA) {
    // Synchronous path into the picker — no await before this call.
    const handle = await window.showDirectoryPicker({
      mode: config.permissionMode,
      id: config.pickerId, // restoreLastFolder: Chromium remembers this id
    });
    if (config.persistHandles) {
      try {
        await idbSet(HANDLE_KEY, handle);
      } catch {
        /* non-fatal: persistence is best-effort */
      }
    }
    return handle;
  }

  if (config.fallbackMode === "webkitdirectory") {
    return pickViaInput();
  }

  throw new Error(
    "Folder selection unavailable: no File System Access API and " +
      "webkitdirectory fallback is disabled in the config.",
  );
}

/** Re-open the last picked folder after a reload (handles don't persist
 *  permissions on their own). Returns null if nothing is stored/granted. */
export async function restoreLastFolder(config = resolveConfig()) {
  if (!config.persistHandles || !config.reRequestPermissionOnReload) {
    return null;
  }
  const handle = await idbGet(HANDLE_KEY);
  if (!handle) return null;
  try {
    const perm = await handle.requestPermission({ mode: config.permissionMode });
    return perm === "granted" ? handle : null;
  } catch {
    return null;
  }
}

/** Synthetic stable id for the UI — browsers never expose real paths. */
export function virtualPath(handle) {
  if (!handle) return null;
  const name = handle.name || "workspace";
  return `workspace://${name}`;
}

/** Read the folder-selection block out of a loaded .fb-browser-ui.json. */
export function fromConfigFile(loadedConfig) {
  return resolveConfig(loadedConfig?.folderSelection ?? {});
}
