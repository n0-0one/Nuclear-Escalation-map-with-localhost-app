//! A fixed HTTPS feed for data-only updates. It never downloads executable code.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

pub const FEED: &str = "https://raw.githubusercontent.com/n0-0one/Nuclear-Escalation-map-with-localhost-app/codex/windows-data-v1";
pub const MAX_PACK: usize = 32 * 1024 * 1024;
pub const FILES: [&str; 12] = [
    "map_data.json",
    "map_data_mirror.json",
    "map_data_city.json",
    "map_data_city_mirror.json",
    "mission_logic.json",
    "mission_logic_mirror.json",
    "mission_logic_city.json",
    "mission_logic_city_mirror.json",
    "presets.json",
    "unit_specs.json",
    "unit_display_names.json",
    "datamine-lock.json",
];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub format_version: u32,
    pub datamine_commit: String,
    pub sha256: String,
    pub bytes: usize,
    pub pack: String,
    pub published_at: u64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSnapshot {
    pub revision: String,
    pub source: String,
    pub data: Option<Value>,
    pub warning: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
    pub revision: String,
    pub updated: bool,
    pub message: String,
}
pub struct Updater {
    directory: PathBuf,
    client: reqwest::Client,
    bundled_revision: String,
    last_check: Option<std::time::Instant>,
    last_result: Option<UpdateResult>,
}
fn hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn ensure(ok: bool, message: &str) -> Result<(), String> {
    if ok {
        Ok(())
    } else {
        Err(message.into())
    }
}
impl Manifest {
    pub fn validate(&self) -> Result<(), String> {
        ensure(
            self.format_version == 1,
            "This data format requires a newer app",
        )?;
        ensure(
            hex(&self.sha256, 64) && hex(&self.datamine_commit, 40),
            "Invalid data revision or checksum",
        )?;
        ensure(
            self.bytes > 0 && self.bytes <= MAX_PACK,
            "Data pack exceeds its size limit",
        )?;
        ensure(
            self.pack == format!("packs/{}.json", self.sha256),
            "Unexpected data pack path",
        )?;
        ensure(self.published_at > 0, "Missing data publication time")
    }
}
fn safe_value(value: &Value, depth: usize) -> Result<(), String> {
    ensure(depth <= 64, "Data nesting is too deep")?;
    match value {
        Value::String(text) => ensure(
            text.len() <= 16384
                && !text.contains(['<', '>'])
                && !text.chars().any(|c| c.is_control()),
            "Unsupported display text",
        )?,
        Value::Array(items) => {
            ensure(items.len() <= 100000, "Data array is too large")?;
            for item in items {
                safe_value(item, depth + 1)?;
            }
        }
        Value::Object(items) => {
            for (key, item) in items {
                ensure(
                    !["__proto__", "prototype", "constructor"].contains(&key.as_str()),
                    "Unsafe dictionary key",
                )?;
                safe_value(&Value::String(key.clone()), depth + 1)?;
                safe_value(item, depth + 1)?;
            }
        }
        Value::Number(number) => ensure(
            number.as_f64().is_some_and(f64::is_finite),
            "Non-finite data value",
        )?,
        _ => {}
    }
    Ok(())
}
fn position(value: &Value) -> bool {
    value.as_array().is_some_and(|a| {
        a.len() == 3
            && a.iter().all(|v| {
                v.as_f64()
                    .is_some_and(|n| n.is_finite() && n.abs() <= 1_000_000.0)
            })
    })
}
pub fn validate_pack(manifest: &Manifest, bytes: &[u8]) -> Result<Value, String> {
    manifest.validate()?;
    ensure(
        bytes.len() == manifest.bytes && format!("{:x}", Sha256::digest(bytes)) == manifest.sha256,
        "Data pack checksum mismatch",
    )?;
    let payload: Value = serde_json::from_slice(bytes).map_err(|_| "Invalid data JSON")?;
    ensure(
        payload["formatVersion"] == 1 && payload["datamineCommit"] == manifest.datamine_commit,
        "Data pack revision mismatch",
    )?;
    let files = payload["files"].as_object().ok_or("Missing data files")?;
    ensure(
        files.len() == FILES.len() && FILES.iter().all(|name| files.contains_key(*name)),
        "Data files do not match the supported allowlist",
    )?;
    safe_value(&payload, 0)?;
    let presets = files["presets.json"]["presets"]
        .as_array()
        .ok_or("Missing scenarios")?;
    let ids: BTreeSet<&str> = presets.iter().filter_map(|p| p["id"].as_str()).collect();
    ensure(
        !ids.is_empty()
            && ids.len() == presets.len()
            && ids.len() <= 20
            && ids.iter().all(|s| {
                s.strip_prefix("rank-").is_some_and(|r| {
                    r.split('-').count() == 2
                        && r.split('-')
                            .all(|n| !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit()))
                })
            }),
        "Invalid scenario identifiers",
    )?;
    let variants = files["presets.json"]["variants"]
        .as_array()
        .ok_or("Missing variants")?;
    let names: BTreeSet<&str> = variants.iter().filter_map(|v| v["id"].as_str()).collect();
    ensure(
        variants.len() == 4
            && names == BTreeSet::from(["standard", "mirror", "city", "city_mirror"]),
        "Unsupported map variants",
    )?;
    for suffix in ["", "_mirror", "_city", "_city_mirror"] {
        let sites = files[&format!("map_data{suffix}.json")]
            .as_array()
            .ok_or("Invalid map data")?;
        ensure(
            !sites.is_empty() && sites.len() <= 10000,
            "Invalid site count",
        )?;
        let mut names = BTreeSet::new();
        for site in sites {
            let name = site["name"].as_str().ok_or("Missing site name")?;
            ensure(
                !name.is_empty()
                    && names.insert(name)
                    && position(&site["world_pos"])
                    && matches!(site["team"].as_u64(), Some(1 | 2)),
                "Invalid site identity or position",
            )?;
            for field in ["units_by_era", "buildings_by_era"] {
                let eras = site[field].as_object().ok_or("Missing site scenarios")?;
                ensure(
                    eras.len() == ids.len() && ids.iter().all(|id| eras.contains_key(*id)),
                    "Site scenario coverage mismatch",
                )?;
                for components in eras.values() {
                    for component in components.as_array().ok_or("Invalid components")? {
                        ensure(
                            position(&component["world_pos"]),
                            "Invalid component position",
                        )?;
                        if let Some(kind) = component["lifecycle"]["kind"].as_str() {
                            ensure(
                                ["none", "restore", "repair_with_site", "mission_rule"]
                                    .contains(&kind),
                                "Unsupported lifecycle",
                            )?;
                        }
                    }
                }
            }
        }
        for site in files[&format!("mission_logic{suffix}.json")]["sites"]
            .as_array()
            .ok_or("Invalid mission logic")?
        {
            ensure(
                site["name"].as_str().is_some_and(|n| names.contains(n))
                    && position(&site["world_pos"]),
                "Unknown mission site",
            )?;
        }
    }
    let specs = files["unit_specs.json"]
        .as_object()
        .ok_or("Invalid unit specifications")?;
    ensure(
        !specs.is_empty()
            && specs
                .values()
                .all(|v| v["model"].as_str().is_some_and(|s| !s.trim().is_empty())),
        "Missing unit model",
    )?;
    ensure(
        files["unit_display_names.json"].is_object(),
        "Invalid display names",
    )?;
    let lock = &files["datamine-lock.json"];
    ensure(
        lock["repository"] == "gszabi99/War-Thunder-Datamine"
            && lock["accepted_commit"] == manifest.datamine_commit
            && lock["sources"].as_array().is_some_and(|s| !s.is_empty()),
        "Invalid datamine provenance",
    )?;
    Ok(payload["files"].clone())
}
impl Updater {
    pub fn new(directory: PathBuf, bundled_revision: String) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .https_only(true)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(30))
            .user_agent(concat!("Nuclear-Thunder-Live/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            directory,
            client,
            bundled_revision,
            last_check: None,
            last_result: None,
        })
    }
    fn read_cache(&self, name: &str) -> Result<(Manifest, Value), String> {
        let path = self.directory.join(name);
        ensure(
            fs::metadata(&path).map_err(|e| e.to_string())?.len() <= 16384,
            "Cached manifest is too large",
        )?;
        let manifest: Manifest =
            serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        manifest.validate()?;
        let path = self.directory.join(format!("{}.json", manifest.sha256));
        ensure(
            fs::metadata(&path).map_err(|e| e.to_string())?.len() == manifest.bytes as u64,
            "Cached data size mismatch",
        )?;
        let data = validate_pack(&manifest, &fs::read(path).map_err(|e| e.to_string())?)?;
        Ok((manifest, data))
    }
    pub fn snapshot(&self) -> DataSnapshot {
        for name in ["active.json", "previous.json"] {
            if let Ok((manifest, data)) = self.read_cache(name) {
                return DataSnapshot {
                    revision: manifest.datamine_commit,
                    source: "downloaded".into(),
                    data: Some(data),
                    warning: if name == "previous.json" {
                        Some(
                            "The newest cache was invalid; using the previous verified data."
                                .into(),
                        )
                    } else {
                        None
                    },
                };
            }
        }
        DataSnapshot {
            revision: self.bundled_revision.clone(),
            source: "bundled".into(),
            data: None,
            warning: if self.directory.join("active.json").exists() {
                Some("Cached update was invalid; using bundled data.".into())
            } else {
                None
            },
        }
    }
    async fn download(&self, url: &str, limit: usize) -> Result<Vec<u8>, String> {
        let mut response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|_| "Data server unavailable; current data is unchanged")?;
        ensure(
            response.status().is_success(),
            &format!(
                "Data server returned HTTP {}; current data is unchanged",
                response.status().as_u16()
            ),
        )?;
        ensure(
            response.content_length().unwrap_or(0) <= limit as u64,
            "Data response exceeds size limit",
        )?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Data download interrupted")?
        {
            ensure(
                bytes.len() + chunk.len() <= limit,
                "Data response exceeds size limit",
            )?;
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }
    pub fn install(&self, manifest: &Manifest, bytes: &[u8]) -> Result<(), String> {
        validate_pack(manifest, bytes)?;
        if let Ok((current, _)) = self.read_cache("active.json") {
            ensure(
                manifest.published_at >= current.published_at,
                "Ignoring an older published data pack",
            )?;
        }
        fs::create_dir_all(&self.directory).map_err(|e| e.to_string())?;
        let pack = self.directory.join(format!("{}.json", manifest.sha256));
        atomic_write(&pack, bytes)?;
        if let Ok((current, _)) = self.read_cache("active.json") {
            atomic_write(
                &self.directory.join("previous.json"),
                &serde_json::to_vec(&current).map_err(|e| e.to_string())?,
            )?;
        }
        atomic_write(
            &self.directory.join("active.json"),
            &serde_json::to_vec(manifest).map_err(|e| e.to_string())?,
        )?;
        // Keep the active and previous packs. Only our exact hash filenames are eligible.
        let previous = self.read_cache("previous.json").ok().map(|(m, _)| m.sha256);
        if let Ok(entries) = fs::read_dir(&self.directory) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if let Some(hash) = name.strip_suffix(".json") {
                    if hex(hash, 64)
                        && hash != manifest.sha256
                        && previous.as_deref() != Some(hash)
                        && entry.file_type().is_ok_and(|t| t.is_file())
                    {
                        let _ = fs::remove_file(entry.path());
                    }
                }
            }
        }
        Ok(())
    }
    pub async fn check(&mut self) -> Result<UpdateResult, String> {
        if self
            .last_check
            .is_some_and(|at| at.elapsed() < Duration::from_secs(60))
        {
            return self
                .last_result
                .clone()
                .ok_or("An update check was attempted recently; try again in a minute".into());
        }
        self.last_check = Some(std::time::Instant::now());
        self.last_result = None;
        let bytes = self
            .download(&format!("{FEED}/manifest.json"), 16384)
            .await?;
        let manifest: Manifest =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid update manifest")?;
        manifest.validate()?;
        if let Ok((current, _)) = self.read_cache("active.json") {
            ensure(
                manifest.published_at >= current.published_at,
                "Ignoring an older published data pack",
            )?;
            if manifest.sha256 == current.sha256 {
                let result = UpdateResult {
                    revision: current.datamine_commit,
                    updated: false,
                    message: "Latest validated data is already cached.".into(),
                };
                self.last_result = Some(result.clone());
                return Ok(result);
            }
        }
        let bytes = self
            .download(&format!("{FEED}/{}", manifest.pack), manifest.bytes)
            .await?;
        self.install(&manifest, &bytes)?;
        let result = UpdateResult {
            revision: manifest.datamine_commit,
            updated: true,
            message: "Verified data downloaded. It will load automatically on the next app launch."
                .into(),
        };
        self.last_result = Some(result.clone());
        Ok(result)
    }
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let temp = path.with_extension("tmp");
    let mut file = fs::File::create(&temp).map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(temp, path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests;
