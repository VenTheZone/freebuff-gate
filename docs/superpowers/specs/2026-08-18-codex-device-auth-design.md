# Codex Device Authentication Design

## Status

Approved design. Implementation pending user review of this document.

## Goal

Let Desktop and paired mobile users connect an OpenAI Codex account through Codex's official device-auth flow:

1. Desktop starts `codex login --device-auth`.
2. UI shows `https://openai.com/codex/device` and one-time code.
3. User approves device from any browser.
4. Codex CLI stores and refreshes credentials locally.
5. Desktop and mobile refresh project/model data.

## Scope

### In scope

- Connect Codex action in existing model picker.
- Desktop proxy endpoints for starting, checking, and cancelling device auth.
- Full-screen popup usable on Desktop and mobile.
- Device URL/code extraction and status polling.
- Timeout, cancellation, missing CLI, and failed-login handling.
- Model/session metadata refresh after successful login.
- Tests for output parsing, process lifecycle, endpoints, and popup behavior.

### Out of scope

- Reimplementing OpenAI authentication or token exchange.
- Storing, proxying, or displaying Codex tokens.
- Adding provider credentials to QR data, relay state, logs, or source control.
- Replacing upstream Freebuff provider/model integration.

Codex models will appear only when upstream Freebuff consumes credentials created by Codex CLI.

## Architecture

`src/freebuff_tailnet_proxy.js` owns a single Desktop-local device-auth process. It starts the official CLI with fixed arguments and `shell: false`:

```text
codex login --device-auth
```

The injected browser UI in `src/mobile-ui.js` adds a Connect Codex action to the existing `.agent-menu`. Its modal is styled in `src/mobile-ui.css`. Desktop requests reach the local proxy directly. Mobile requests traverse the existing relay and connector to the same Desktop proxy; relay behavior does not change.

Codex CLI remains owner of authentication state. The UI receives only a device URL, user code, and coarse process status.

## API contract

All endpoints use existing UI authentication and local proxy access controls.

### `POST /api/fb/codex/device/start`

Starts one device-auth process. A second active start returns a conflict error.

Success:

```json
{
  "state": "waiting",
  "deviceUrl": "https://openai.com/codex/device",
  "userCode": "ABCD-EFGH"
}
```

Errors identify only actionable conditions, such as `codex_cli_missing`, `codex_login_active`, or `codex_login_failed`.

### `GET /api/fb/codex/device/status`

Returns one of `idle`, `waiting`, `connected`, `failed`, or `cancelled`, plus `error` when needed. It never returns process output or credentials.

### `POST /api/fb/codex/device/cancel`

Terminates the active process and returns `cancelled`. Calling it while idle is harmless.

## UI flow

1. User opens model picker.
2. User taps **Connect Codex**.
3. Modal displays device URL, code, copy action, and open-link action.
4. Modal polls status every second while waiting.
5. Successful status displays **Codex connected**, refreshes `/api/projects`, and closes after refresh.
6. Failure displays a short actionable message with retry.
7. Cancel stops polling and terminates the local process.

The model picker remains authoritative. No parallel model registry is added.

## Process and security rules

- Use `spawn` with fixed executable arguments and `shell: false`.
- Allow only one active process.
- Enforce a ten-minute timeout.
- Terminate on cancel, timeout, proxy shutdown, or client disconnect where practical.
- Parse only the expected device URL and user code from bounded stdout/stderr chunks.
- Never return or log raw CLI output, access tokens, refresh tokens, cookies, or auth-file contents.
- Do not send provider credentials through the relay or mobile pairing payload.
- Preserve existing relay and connector authentication boundaries.

## Error handling

- Missing `codex` executable: explain that Codex CLI must be installed.
- CLI exits before code extraction: show login-start failure and allow retry.
- CLI exits nonzero after code extraction: show approval failure and allow retry.
- Timeout: terminate process and show expired-login message.
- Malformed output: fail closed; do not expose raw output.
- Proxy restart: clear in-memory state; user can start a new login.

## Testing

- Unit-test URL/code extraction with synthetic CLI output, including malformed output.
- Test start/status/cancel lifecycle and duplicate-start rejection.
- Test missing executable and nonzero exit handling.
- Extend existing mobile UI fixture with Connect Codex modal and status states.
- Assert successful status triggers project/model refresh.
- Run existing JavaScript and mobile-connect tests without modifying unrelated working-tree changes.

## Acceptance criteria

- Desktop user can start official device auth from model picker.
- Mobile user can start the same flow through paired Desktop.
- User can open `https://openai.com/codex/device`, enter displayed code, and see completion.
- No provider token appears in browser responses, relay state, QR data, or logs.
- Cancel, timeout, retry, missing CLI, and failed login behave predictably.
- Successful login refreshes available project/model metadata.
- Existing pairing, relay, model, and session behavior remains unchanged.
- If upstream Freebuff does not expose Codex after authentication, UI reports connection success without pretending models are available.
