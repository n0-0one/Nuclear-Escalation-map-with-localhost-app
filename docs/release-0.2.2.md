# Nuclear Thunder Live 0.2.2

The Windows app repository now owns automatic datamine delivery and has four meaningful checks: `web`, `rust`, `windows` and `datamine`. Pages-only and duplicate release checks have been removed from this repository.

- Install **Nuclear-Thunder-Live-Setup.exe** once to switch the app to its own validated data feed. Version 0.2.1 continues using the earlier website feed.
- The daily pipeline regenerates War Thunder mission data, tests the same candidate in the browser and Windows EXE, updates `automation/datamine-update`, and publishes the compatible JSON pack automatically after all checks pass.
- The app checks at startup and every four hours. Downloaded data loads on the next launch. **Settings → Automatic mission data → Check data now** performs an immediate check.
- Failed validation leaves the previous feed available. Offline startup uses cached or bundled data. Executable code changes still require a normal release.
- Native CI tests use an isolated cache with background network updates disabled during the test, ensuring the candidate cannot be replaced mid-test by the previously published pack.

The map and extractor originate from [majorlier's Nuclear Thunder Interactive Map](https://github.com/majorlier/nuclear-thunder-interactive-map). See [automatic data delivery](https://github.com/n0-0one/Nuclear-Escalation-map-with-localhost-app/blob/main/docs/datamine.md) and [the current workflow](https://github.com/n0-0one/Nuclear-Escalation-map-with-localhost-app/actions/workflows/ci.yml).

This release preserves the live tracking, SAM/BR fixes, settings and companion minimap from 0.2.1. Previously documented feature suggestions remain suggestions only.
