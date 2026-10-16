# Automatic War Thunder data updates for Windows

The map and reviewed extractor originate from [majorlier's Nuclear Thunder Interactive Map](https://github.com/majorlier/nuclear-thunder-interactive-map), including the separate [automation/datamine-update branch](https://github.com/majorlier/nuclear-thunder-interactive-map/tree/automation/datamine-update).

This Windows repository owns its automation branch and its data feed. It does not depend on a pull request being merged into the website repository.

## Four checks on main

The single **Validate and update Windows app** workflow provides exactly four named jobs on main pushes, pull requests, manual runs and the daily schedule:

| Check | What it verifies |
| --- | --- |
| `web` | Reviewed extraction and publication tests, regenerated mission data, application logic, production web build and browser regressions |
| `rust` | Native updater validation of the exact candidate pack, Rust tests and optional bridge security |
| `windows` | A real Windows EXE and installer build; hidden native smoke using the candidate pack in an isolated cache |
| `datamine` | Artifact integrity and, after all three preceding checks pass, publication of the source snapshot and Windows feed |

There are no Pages deployment jobs in this repository. The separate website repository continues to own GitHub Pages. Tag creation does not start duplicate validation workflows. On pull requests the fourth check verifies the artifact without publishing anything.

## Automatic delivery

The workflow runs daily at **05:23 UTC**, on every main push, and through **Actions → Validate and update Windows app → Run workflow**. GitHub may delay scheduled runs. A manual run can select a full datamine commit SHA for reproduction.

1. Resolve one pinned revision of `gszabi99/War-Thunder-Datamine` and run the reviewed, vendored extractor. No executable tooling is downloaded from a moving branch.
2. Validate the twelve supported JSON files, then run browser and native tests against the generated candidate.
3. Refresh [`automation/datamine-update`](https://github.com/n0-0one/Nuclear-Escalation-map-with-localhost-app/tree/automation/datamine-update). The snapshot contains main's reviewed code with only the allowlisted data paths replaced. Existing branch history is retained; main is not rewritten or automatically merged.
4. Publish the immutable JSON pack and SHA-256 manifest on [`codex/windows-data-v1`](https://github.com/n0-0one/Nuclear-Escalation-map-with-localhost-app/tree/codex/windows-data-v1). Identical data does not republish the feed. A failed test leaves the previous published pack available.
5. Windows **0.2.2 and later** reads this application's own feed automatically. No manual PR approval or new EXE is needed for compatible mission-data updates.

The only write-capable job runs after all checks succeed. Its repository token is exposed only to the publishing step. The publisher verifies the artifact again, rejects unsupported paths, and refuses to publish an obsolete candidate if main advanced during validation. No PR-approval permission or personal access token is needed.

## Installed applications

Install **0.2.2 once** to switch from the earlier shared website feed to this app repository's feed. Version 0.2.1 keeps using the original website feed; it does not silently change its update source.

The app loads its verified cache before map initialization, checks shortly after launch and every four hours, and provides **Settings → Automatic mission data → Check data now**. Downloaded data becomes active on the next launch so an ongoing battle is not reset. Offline startup uses the last verified cache or the bundled data.

The native updater accepts only the fixed HTTPS GitHub path, refuses redirects, limits response sizes, verifies SHA-256 and validates the schema. It keeps the previous valid cache as a fallback. No game telemetry or HUD text is sent in update requests. The overlay cannot invoke the updater or read the cache.

Executable code, new map formats and artwork require a normal application release. This is automatic mission-data delivery, not an executable self-updater. SHA-256 checks integrity against the HTTPS manifest; it is not an independent publisher signature.

## Allowed generated files

Only these paths under `apps/web/public` may be replaced:

- `map_data.json`, `map_data_mirror.json`, `map_data_city.json`, `map_data_city_mirror.json`
- `mission_logic.json`, `mission_logic_mirror.json`, `mission_logic_city.json`, `mission_logic_city_mirror.json`
- `presets.json`, `unit_specs.json`, `unit_display_names.json`, `datamine-lock.json`

Extraction provenance remains in `scripts/datamine/provenance.json`. Exact English HUD names come from the same pinned localization CSV after verification of its Git blob hash. Renderer code, desktop integration, terrain and artwork are outside the data pack.

## Local verification

```sh
node --test scripts/datamine/publication.test.mjs
python scripts/datamine/test_feed.py
python scripts/datamine/test_update.py
python scripts/datamine/tools/test_mission_extraction.py
python scripts/datamine/update.py --validate-only
python scripts/datamine/build_feed.py
cargo run --locked -p datamine-updater --example verify_feed -- .local/windows-feed
```

`python scripts/datamine/update.py --check` performs real regeneration without importing it. Generated data must pass the full workflow before publication. Scheduled workflows in public repositories can be disabled by GitHub after prolonged inactivity; their current enabled state is shown in Actions.
