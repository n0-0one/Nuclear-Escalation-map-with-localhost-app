//! Validate a CI candidate using exactly the same boundary as the installed app.
use datamine_updater::{validate_pack, Manifest, Updater};
use std::{fs, path::PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let root = PathBuf::from(args.next().ok_or("Expected a feed directory")?);
    let cache = args.next().map(PathBuf::from);
    if args.next().is_some() {
        return Err("Unexpected arguments".into());
    }
    let mut value: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join("manifest.json"))?)?;
    // Candidates are not published yet. This timestamp is used only in an isolated test cache.
    if value.get("publishedAt").is_none() {
        value["publishedAt"] = 1.into();
    }
    let manifest: Manifest = serde_json::from_value(value)?;
    manifest.validate()?;
    let bytes = fs::read(root.join(&manifest.pack))?;
    validate_pack(&manifest, &bytes)?;
    if let Some(directory) = cache {
        let updater = Updater::new(directory, "bundled".into())?;
        updater.install(&manifest, &bytes)?;
        if updater.snapshot().revision != manifest.datamine_commit {
            return Err("Cache activation failed".into());
        }
    }
    println!(
        "Verified candidate {} ({})",
        manifest.datamine_commit, manifest.sha256
    );
    Ok(())
}
