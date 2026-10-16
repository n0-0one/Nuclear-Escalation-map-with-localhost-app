# Nuclear Thunder Live

A standalone Nuclear Escalation map for War Thunder, available as a static website and a Windows application. It builds on **[Nuclear Thunder Interactive Map by majorlier](https://github.com/majorlier/nuclear-thunder-interactive-map)** and preserves the original map data, terrain, layers, icons and planning tools. Live adds local game telemetry, moving contacts, battle notes, route planning and a desktop companion minimap.

**Original project:** [majorlier's interactive map](https://majorlier.github.io/nuclear-thunder-interactive-map/) · [source and documentation](https://github.com/majorlier/nuclear-thunder-interactive-map). Attribution and third-party notices are in [LICENSES/NOTICE.md](LICENSES/NOTICE.md). This is an independent community project and is not affiliated with Gaijin Entertainment.

This is a field-test build. The local API does not reliably identify the current BR bracket, every vehicle, or every destruction event. Unknown data stays unknown and manual corrections remain available. See [the 0.2.1 verification record](docs/acceptance-0.2.1.md) for live, replay, synthetic and native evidence. The [0.1.0 record](docs/acceptance.md) is historical.

## Start on Windows

Download the Windows package or installer from [the Windows app repository's releases](https://github.com/n0-0one/Nuclear-Escalation-map-with-localhost-app/releases). Extract the complete ZIP, then run `Nuclear-Thunder-Live.exe`, or run `Nuclear-Thunder-Live-Setup.exe` to install it. Microsoft Edge WebView2 Runtime is required and is usually already present on Windows 11. The installer can download WebView2 if it is missing. Releases are not signed with a publisher certificate.

The map and its assets are bundled with the application. Version 0.2.2 uses this Windows repository's own validated mission-data feed. Updates download automatically at startup and every four hours, then load on the next launch. Settings shows the loaded revision and a manual update check. Offline startup uses verified cached or bundled data. **Native War Thunder** connects directly to the game running on this computer. The map also works when the game is closed. The desktop application does not need the optional bridge.

Local build outputs are `target/release/ntl-desktop.exe`, `target/release/bundle/nsis/Nuclear Thunder Live_<version>_x64-setup.exe` and `target/release/ntl-bridge.exe`. Packaged releases are written to `release/<version>/`, including Windows, Web and Source ZIP files and `SHA256SUMS.txt`.

## Use the map

1. Choose **Archipelago** or **South Eastern City**, the battle's BR bracket and the correct side layout. Keep manual selection available when the game does not provide enough evidence to detect a setting.
2. Use the original layers panel to show units, weapon ranges, terrain and roads. The original Measure, Line of sight, Flight brush and Threat cover tools are still available.
3. Open **Battle controls** for the live connection, selected target, vehicle routes, battle history and settings. Collapse it when you want more room for the map.
4. Select a site or search for it to inspect its components. Automatic tracking shows active, explicitly destroyed and possibly destroyed components. A fresh HUD kill can be linked to one recently missing matching component; this association remains inferred. Mark whole site destroyed records your confirmation for every component. **Undo** reverses a manual change.
5. Use target focus and the previous-view control to move between a selected contact and your earlier map position. Use route controls to inspect a route without losing the map context.
6. Create a planned flight with 2–12 points. Unknown threats are included by default. The result is an estimate, not a guarantee of safe terrain clearance or concealment.

**Predicted** routes come from mission data. **Observed** movement comes from local telemetry, with inferred continuity rather than a guaranteed vehicle ID. **Simulated** means demonstration data; leaving demo mode removes its simulated battle state. Disappearing from telemetry does not by itself mean that a vehicle or airfield was destroyed.

The live display uses player-relative contact information when it is available. A faction name such as NATO or USSR is not sufficient evidence that a contact is an enemy. Unsupported contacts and identities remain unknown instead of receiving a guessed team or aircraft role.

**Settings** controls update speed, marker size, trail length, smooth movement, aiming-point visibility and nuclear-aircraft highlights. Choose a slower update speed and shorter trails to reduce load. Yellow crosshairs show aiming points and a red diamond shows your point of interest when the game exposes them. The observed live API sample included a point of interest, but no yellow aiming-point records; parser support is not proof that every game mode reports those marks.

Select an aircraft and choose **Mark this aircraft as nuclear (manual)** when you have confirmed its role yourself. Automatic nuclear highlighting requires an explicit nuclear identifier from the game. A generic aircraft marker or model alone does not establish that it is carrying a nuclear weapon. Manual labels remain identified as manual and are tied to an estimated track that can lose continuity.

Battle detection combines static placements, runway geometry and exact static-unit names in the English HUD log before changing a setting. Choose My faction when the default and mirrored layouts remain indistinguishable. If two BR presets share the same observed placements and unit names, the bracket stays ambiguous. Enter the battle's maximum BR yourself in that case; side-layout detection can continue independently. Your own aircraft's BR is not treated as the match's maximum BR.

Battle export saves context, notes and states as JSON. Diagnostic export contains connection status, errors and basic metrics; it excludes pairing codes and HUD messages. The desktop writes a new timestamped file in Downloads. The website uses the browser's normal download flow.

## Desktop companion minimap

The desktop overlay is a small, resizable, always-on-top window showing nearby information from the main application. Open it from the main application's overlay controls. Move it by its header and resize it by its border. Click-through mode lets mouse input pass to the game; use the main window to switch click-through off or reopen the overlay when you want to move it again.

Keep the main application running. It owns the single telemetry connection and passes map frames to the overlay. Closing the main window closes the overlay. Minimizing the main window does not close the overlay. Display opacity is applied by the frontend; it does not change the game window.

Use windowed or borderless game mode. An ordinary desktop companion window is not guaranteed to appear above exclusive fullscreen games. This feature does not inject into War Thunder, read game memory, register global keyboard hooks or bypass anti-cheat. A website cannot create a native always-on-top game overlay; the desktop application is required for that window behavior. See [the overlay contract](docs/overlay.md).

## Run the website locally

Install Node.js 24, then run these commands from the repository directory:

```powershell
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`. To build and preview the production website:

```powershell
npm run build
npm run preview
```

Open `http://127.0.0.1:4173`. Serve the generated `dist/` directory with any static HTTP server. Do not open `index.html` through `file://`, because browser restrictions prevent the map's JSON data from loading that way. All map assets are local to the build; the original project does not need to be running or downloaded at runtime.

## Connect the website to War Thunder

**Manual / offline** is always available. **Direct localhost** tries the game's `127.0.0.1:8111` API; whether it succeeds depends on game CORS and browser local-network rules. If the connection is blocked, use the local bridge or the desktop application. Do not disable browser protections.

Start the optional bridge:

```powershell
.\target\release\ntl-bridge.exe
```

Select **Local bridge** on the website, paste the pairing code printed in the bridge's console and connect. A new random code is generated each time the bridge starts. By default, it accepts only the local preview origins on ports 5173 and 4173. For the GitHub Pages website, use:

```powershell
.\target\release\ntl-bridge.exe --origin https://n0-0one.github.io
```

The origin must not include a repository path or trailing slash. The bridge listens only on `127.0.0.1:8112`; press Ctrl+C to stop it. Each visitor connects to their own game and their own bridge. Telemetry is not uploaded to the website host. A browser may ask for local-network access; if that connection is unsupported, use the desktop application.

## Build for Windows

Requirements: Node.js 24, Rust stable with the MSVC target, Visual Studio C++ Build Tools with a Windows SDK, and WebView2. Dependency versions are recorded in the lockfiles.

```powershell
npm ci
npm run desktop:build
cargo build --locked --release -p ntl-bridge
```

`desktop:build` builds the frontend, enables Tauri's production custom protocol and generates the NSIS installer. The first build downloads dependencies and NSIS tools. A plain `cargo build --release` without `custom-protocol` is a development build that expects Vite; it is not a standalone release.

To build only the standalone EXE:

```powershell
npm run build
cargo build --locked --release -p ntl-desktop --features custom-protocol
```

For development, run `npm run dev` in one terminal and `npm run desktop:dev` in another. Closing the main native window exits the application and its companion window. No hidden bridge process is started.

## Hosting, releases and data updates

The Windows repository has four checks: `web`, `rust`, `windows` and `datamine`. Its daily workflow refreshes [`automation/datamine-update`](https://github.com/n0-0one/Nuclear-Escalation-map-with-localhost-app/tree/automation/datamine-update) and publishes tested data automatically. Install 0.2.2 once to use this app-specific feed; see [automatic updates](docs/datamine.md).

The website repository is [n0-0one/Nuclear-Escalation-map-with-localhost](https://github.com/n0-0one/Nuclear-Escalation-map-with-localhost). The Windows app repository is [n0-0one/Nuclear-Escalation-map-with-localhost-app](https://github.com/n0-0one/Nuclear-Escalation-map-with-localhost-app). The Pages address is [Nuclear Thunder Live](https://n0-0one.github.io/Nuclear-Escalation-map-with-localhost/). Check the repository's latest workflow run for the deployed revision.

The website repository owns its Pages deployment workflow. This Windows repository does not run or skip Pages jobs. Relative web asset paths still support repository subpaths and custom domains.

`.github/workflows/ci.yml` builds and tests the Windows application and installer on `windows-latest`, validates the exact datamine candidate, and publishes data after all four checks pass. The Windows artifact contains the application, installer and third-party notices. Application installers are published as normal versioned GitHub releases; successful source checks alone do not establish release availability.

Map updates follow the upstream project's generated data and preserve source attribution. See [the datamine update process](docs/datamine.md) for the automation branch, validation rules and pinned source revisions. The validated JSON feed updates installed Windows copies without a new EXE. The app's generated source snapshot updates automatically on its data branch. The separate website repository retains its own draft PR review process.

## Verify and package a build

```powershell
npm test
npm run build
npm run test:browser
cargo test --locked -p war-thunder-telemetry -p ntl-bridge
node tests/integration/bridge-security.mjs
```

Browser tests use Microsoft Edge. For a real-game browser check, start Vite and run `node tests/integration/bridge-security.mjs --browser` during a battle. It starts its own bridge and stops it afterward, so port 8112 must be available. Reports stay in ignored `docs/verification/` and are not uploaded.

For the production subpath check, start `node scripts/serve-build.mjs`, then run `node tests/integration/production-browser.mjs`. It checks `/ntl-test/`, both maps, scenario switching, icon families and local resource loading.

For a native check without Vite, run `./tests/integration/native-smoke.ps1`. It starts a hidden instance, checks embedded map loading and the native telemetry call, writes a local report and exits the test process. The game does not need to be running for map checks to pass. It does not close an existing user window.

After building the website, desktop and bridge, and adding sources to Git, run `python scripts/package-release.py`. Use `--desktop-dir target/final/release` for an alternative build directory. Only Git-tracked source files enter the source archive; live telemetry captures and local reports are excluded.

## Documentation

- [Architecture](docs/architecture.md)
- [Telemetry and confidence](docs/telemetry.md)
- [Map data and provenance](docs/map-data.md)
- [Desktop companion overlay](docs/overlay.md)
- [Data update process](docs/datamine.md)
- [Known limitations](docs/limitations.md)
- [Verification record](docs/acceptance.md)
- [Attribution and third-party notices](LICENSES/NOTICE.md)

Feature ideas are listed in [Proposed improvements](docs/suggestions.md); these are suggestions, not implemented features.
