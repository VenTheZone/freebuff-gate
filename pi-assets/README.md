# Bundled Pi assets

This directory contains project-owned Pi extensions and npm package manifests.
It intentionally excludes `auth.json`, `free.json`, model caches, provider caches,
sessions, and `node_modules`.

`install-mobile-connect` syncs these assets into `~/.pi/agent` when assets are
available beside installer source. Run explicit dependency installation only
when needed:

```bash
node src/sync-pi-assets.js --install-dependencies
```

API keys stay in Pi's local `~/.pi/agent/auth.json` and never belong here.
