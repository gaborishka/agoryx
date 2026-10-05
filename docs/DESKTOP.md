# Agoryx for macOS

Agoryx 0.1.0 packages the room UI and daemon in an **Apple Silicon (arm64)** Electron app. The app runs the daemon using the Mac's own Node installation.

## Install and start

Download the current DMG from [Releases](https://github.com/gaborishka/agoryx/releases/latest), open it, and drag **Agoryx.app** into Applications.

Install Node.js 22+ and at least one supported native agent CLI, then complete that provider's normal sign-in. For multi-agent protocols, seat enough supported agents for the roles shown in setup.

The app checks Node, the packaged core, native SQLite loading, available agents/sign-ins, Git, writable state and daemon status. Missing requirements appear with a corrective action. `agoryx doctor` provides the corresponding terminal diagnostics.

The distributed release is intended to be Developer ID signed and notarized. A local developer build is unsigned unless a signing identity is supplied. Verify an artifact's actual signing/notarization status rather than inferring it from the filename; [release verification](RELEASING.md).

## How the app runs

1. Read the login shell's environment so Node and agents installed with Homebrew, nvm or a user-local prefix can be found.
2. Run setup checks.
3. Connect to the daemon for the selected `AGORYX_HOME`, or start it if none is available.
4. Open the authenticated room UI.
5. Supervise the daemon and reconnect after a restart. Repeated startup failure returns to diagnostics.

The daemon is a normal Node process, not Electron's embedded Node. Agent shims call that same runtime, native modules use its ABI, and the daemon can outlive the window.

**Quitting the app leaves the daemon running.** Use the daemon's Stop/Down controls when you intend to stop work. Closing a window or uninstalling a DMG does not erase local conversations.

Before giving a process the daemon token, the app checks that the port belongs to the PID recorded by the daemon. An unrelated process on the port is not treated as Agoryx.

## Configuration and data

The default room state is `~/.local/state/agoryx/agora`, respecting XDG state configuration. `AGORYX_HOME` overrides it; `AGORYX_WORKSPACES` overrides generated Work-folder placement.

Login-shell environment discovery is bounded. If the shell does not answer, the app uses a fallback search path and reports missing tools. Turn-scoped Agoryx credentials are not inherited as desktop configuration.

The optional Jev provider key belongs to the daemon environment. A source checkout can read its local `.env`; the packaged application does not contain your checkout's `.env`. Do not copy secrets into the application bundle.

Window and desktop preferences live in `~/Library/Application Support/Agoryx`. Native Claude/Codex sign-ins and session histories remain in those products' own locations.

## Attention

The tray, Dock badge and optional notifications reflect rooms that need the human: addressed requests, errors, stops or completed activity according to the room's attention model. Looking at the relevant room updates its seen cursor.

Notification behavior depends on macOS permissions and a suitable signed application identity. A development Electron process is not equivalent to the released signed app.

The visible state should be derived from real room events. A quiet room is not evidence that its task is correct or complete.

## Daemon at login

```sh
agoryx service install
agoryx service status
agoryx service uninstall
```

The macOS LaunchAgent is scoped to the current `AGORYX_HOME`. It starts at login and restarts after a crash. Its plist holds paths and the home, not provider keys; it reads the login-shell environment at startup.

After moving the install or upgrading Node, reinstall the service so its executable paths remain valid. `agoryx down` stops the daemon cleanly; `agoryx up -d` can start it again. Uninstalling the service stops the daemon it owns.

## Use a phone

The daemon listens only on loopback by default. Enable an appropriate route explicitly:

```sh
# Same Wi-Fi; HTTP does not support push notifications.
agoryx up -d --lan
agoryx pair

# HTTPS through an existing Tailscale installation.
agoryx up -d --tailscale
tailscale serve --bg 7717
agoryx pair

# Return to this computer only.
agoryx up --local

agoryx devices
agoryx devices revoke DEVICE_ID
```

Pairing provides a one-time QR link or typed code that expires after five minutes. Devices receive separate HttpOnly credentials, stored as hashes by the daemon, and can be revoked. Typed code attempts are rate-limited. The human's local token is not a general remote-access credential.

A phone can act as the local human for permitted room actions. It cannot pair/revoke more devices or stop the daemon. File-preview access is also device-scoped and revocable. HTTPS is needed for notifications; on iPhone, add the app to the Home Screen and pair that app's own session.

`--lan`, `--tailscale`, `--allow-host` and `--local` update and persist exposure configuration. Enabling one is a meaningful access change; do it intentionally. Do not publish the daemon token.

## Agent-driven browser

The desktop room browser is a separate surface driven through scoped browser tools/MCP integration. It is not the same trusted window as the application's UI.

- Each room gets a separate in-memory browser session.
- Agent panes have no trusted preload bridge.
- Permissions, hardware devices, sign-in prompts, file choosers and downloads are restricted.
- Navigation to files and privileged browser schemes is refused.
- Agoryx endpoints and known daemon ports are blocked; requests are marked so the daemon can reject them.
- Custom previews cannot acquire the human application's authority.

Use an independently authorized browser and isolated daemon for product self-testing. Moving the application to another port is not a reason to weaken the agent-browser boundary.

## Develop from a checkout

```sh
npm ci
npm run build
npm --prefix desktop ci
npm run desktop
```

For a separate test instance:

```sh
AGORYX_HOME=/tmp/agoryx-desktop-check \
AGORYX_WORKSPACES=/tmp/agoryx-desktop-workspaces \
npm run desktop
```

Use a unique disposable home and workspace for each manual test. Do not restart the user's real daemon while it has active work.

Package locally with `npm --prefix desktop run dist -- --publish never`. Signing, notarization and distribution checks are in [Releasing](RELEASING.md).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Node or agent not found | Run `agoryx doctor` and inspect the login shell's PATH. The app does not bundle Node. |
| Provider is signed out | Reconnect using its native CLI, then retry. Do not paste credentials into Agoryx messages. |
| Daemon will not attach | Inspect the reported process/port and daemon log. Do not replace an unrelated listener. |
| Old UI after rebuilding | Confirm which daemon/install the app uses, stop only an idle test instance, and launch the intended build. |
| Private mode unavailable | Check the macOS isolation capability and provider availability. Unsupported platforms fail closed. |
| Packaged SQLite check fails | Verify the staged production dependencies and the Node runtime; see the release gate. |
| Notifications absent | Check the app's signing identity and macOS notification permission. |

## Source map

`desktop/src/main.ts` owns the window and menu; `preload.cts` exposes restricted bridges; `browserpane.ts` owns the agent browser. `internal/desktop/` provides setup checks, environment discovery, daemon supervision, attention, browser hosting and launchd integration.

The packaged core is under `Agoryx.app/Contents/Resources/agoryx`. It contains `bin`, compiled `dist`, built `ui/dist`, package metadata and staged production dependencies. Build output belongs in `desktop/release` and is ignored by Git.
