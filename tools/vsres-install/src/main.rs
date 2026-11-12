//! vsres-install — install/uninstall the VapourSynth for Resolve OFX bundle.
//!
//! Status/install/uninstall for `/Library/OFX/Plugins/VapourSynth.ofx.bundle`
//! (override with --root, used by tests). Never escalates by itself: when the
//! target needs admin, it asks macOS for one explicit `do shell script … with
//! administrator privileges` running a fixed, single-quoted POSIX command
//! (mv-backup + ditto). All paths that feed that command are validated and
//! shell-escaped here; the helper is spawned with discrete argv elements by
//! the companion, never through a shell.
//!
//! Trust model: by default the SOURCE bundle must verify with `codesign
//! --deep --strict` and carry the expected TeamIdentifier (fail closed).
//! `--skip-verify` exists for tests against synthetic bundles and only has an
//! effect together with a non-default `--root`.
//!
//! Output: one JSON object on stdout. Errors also end up there (`ok:false`)
//! with a nonzero exit code; usage errors exit 64.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_ROOT: &str = "/Library/OFX/Plugins";
const BUNDLE_NAME: &str = "VapourSynth.ofx.bundle";
const EXPECTED_TEAM: &str = "4ZT24C8JQZ";
const VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let code = match run(&args) {
        Ok(json) => {
            println!("{json}");
            0
        }
        Err(Exit::Usage(msg)) => {
            println!("{}", json_obj(&[("ok", "false"), ("error", &msg)]));
            64
        }
        Err(Exit::Fail(msg)) => {
            println!("{}", json_obj(&[("ok", "false"), ("error", &msg)]));
            2
        }
    };
    std::process::exit(code);
}

enum Exit {
    Usage(String),
    Fail(String),
}

struct Opts {
    cmd: String,
    root: PathBuf,
    source: Option<PathBuf>,
    toml_helper: Option<PathBuf>,
    skip_verify: bool,
    allow_resolve_running: bool,
    team: String,
}

fn parse(args: &[String]) -> Result<Opts, Exit> {
    if args.is_empty() {
        return Err(Exit::Usage(
            "usage: vsres-install status|install|uninstall [--root DIR] \
             [--source BUNDLE] [--toml-helper SCRIPT] [--skip-verify] \
             [--allow-resolve-running] [--team ID]"
                .into(),
        ));
    }
    let mut o = Opts {
        cmd: args[0].clone(),
        root: PathBuf::from(DEFAULT_ROOT),
        source: None,
        toml_helper: None,
        skip_verify: false,
        allow_resolve_running: false,
        team: EXPECTED_TEAM.into(),
    };
    if !matches!(o.cmd.as_str(), "status" | "install" | "uninstall") {
        return Err(Exit::Usage(format!("unknown command: {}", o.cmd)));
    }
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--root" | "--source" | "--toml-helper" | "--team" => {
                let v = args
                    .get(i + 1)
                    .ok_or_else(|| Exit::Usage(format!("{} needs a value", args[i])))?;
                match args[i].as_str() {
                    "--root" => o.root = PathBuf::from(v),
                    "--source" => o.source = Some(PathBuf::from(v)),
                    "--toml-helper" => o.toml_helper = Some(PathBuf::from(v)),
                    _ => o.team = v.clone(),
                }
                i += 2;
            }
            "--skip-verify" => {
                o.skip_verify = true;
                i += 1;
            }
            "--allow-resolve-running" => {
                o.allow_resolve_running = true;
                i += 1;
            }
            other => return Err(Exit::Usage(format!("unknown argument: {other}"))),
        }
    }
    if o.skip_verify && o.root == Path::new(DEFAULT_ROOT) {
        // Fail closed: the override only exists for tests against synthetic
        // bundles in non-default roots.
        return Err(Exit::Usage(
            "--skip-verify requires a non-default --root (test mode only)".into(),
        ));
    }
    Ok(o)
}

fn run(args: &[String]) -> Result<String, Exit> {
    let o = parse(args)?;
    let dst = o.root.join(BUNDLE_NAME);
    match o.cmd.as_str() {
        "status" => Ok(status_json(&dst, &o.root)),
        "install" => install(&o, &dst),
        "uninstall" => uninstall(&o, &dst),
        _ => unreachable!(),
    }
}

// ── helpers ──────────────────────────────────────────────────────────────────

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// Minimal object builder: values are raw strings unless wrapped —
/// `("k", "raw:true")`? No: every value here is a JSON *string* except the
/// handful of booleans; callers pass pre-encoded values via json_* helpers.
fn json_obj(pairs: &[(&str, &str)]) -> String {
    let body: Vec<String> = pairs
        .iter()
        .map(|(k, v)| format!("\"{}\":\"{}\"", json_escape(k), json_escape(v)))
        .collect();
    format!("{{{}}}", body.join(","))
}

fn jb(b: bool) -> String {
    if b { "true".into() } else { "false".into() }
}

fn jnull() -> String {
    "null".into()
}

fn jstr(s: &str) -> String {
    format!("\"{}\"", json_escape(s))
}

fn field(k: &str, v: &str) -> String {
    format!("\"{}\":{}", json_escape(k), v)
}

fn read_version(bundle: &Path) -> Option<String> {
    let plist = fs::read_to_string(bundle.join("Contents/Info.plist")).ok()?;
    let key = "<key>CFBundleVersion</key>";
    let at = plist.find(key)? + key.len();
    let rest = &plist[at..];
    let start = rest.find("<string>")? + "<string>".len();
    let end = rest[start..].find("</string>")? + start;
    Some(rest[start..end].trim().to_string())
}

fn resolve_running() -> bool {
    Command::new("/usr/bin/pgrep")
        .args(["-x", "Resolve"])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn bundle_looks_complete(bundle: &Path) -> bool {
    bundle.join("Contents/MacOS/VapourSynth.ofx").is_file()
        && bundle.join("Contents/Info.plist").is_file()
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn parent_writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".vsres-write-probe-{}", std::process::id()));
    match fs::File::create(&probe) {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

fn now_ts() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Unique backup path: `.bak-<unix-seconds>`, suffixed if that name is taken —
/// rapid successive installs within the same second must not collide.
fn backup_path(dst: &Path) -> PathBuf {
    let base = format!("{BUNDLE_NAME}.bak-{}", now_ts());
    let mut cand = dst.with_file_name(&base);
    let mut n = 1;
    while cand.exists() {
        cand = dst.with_file_name(format!("{base}-{n}"));
        n += 1;
    }
    cand
}

/// Run one privileged shell script via the standard macOS auth dialog.
/// `script` must already be fully quoted/path-escaped.
fn run_admin(script: &str) -> Result<(), String> {
    let osa = format!(
        "do shell script \"{}\" with administrator privileges",
        script.replace('\\', "\\\\").replace('"', "\\\"")
    );
    let out = Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(&osa)
        .output()
        .map_err(|e| format!("osascript failed to start: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.contains("-128") {
            "administrator authorization was cancelled".into()
        } else {
            format!("privileged step failed: {err}")
        })
    }
}

fn verify_signature(bundle: &Path, team: &str) -> Result<(), String> {
    let v = Command::new("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(bundle)
        .output()
        .map_err(|e| format!("codesign failed to start: {e}"))?;
    if !v.status.success() {
        return Err(format!(
            "source bundle fails codesign verification: {}",
            String::from_utf8_lossy(&v.stderr).trim()
        ));
    }
    let d = Command::new("/usr/bin/codesign")
        .args(["-dv", "--verbose=2"])
        .arg(bundle)
        .output()
        .map_err(|e| format!("codesign failed to start: {e}"))?;
    let info = String::from_utf8_lossy(&d.stderr);
    let want = format!("TeamIdentifier={team}");
    if !info.contains(&want) {
        return Err(format!(
            "source bundle is not signed by the expected team ({want} not found)"
        ));
    }
    Ok(())
}

fn status_json(dst: &Path, _root: &Path) -> String {
    let installed = bundle_looks_complete(dst);
    let version = if installed { read_version(dst) } else { None };
    let backups: Vec<String> = fs::read_dir(dst.parent().unwrap_or(Path::new("/")))
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| n.starts_with(&format!("{BUNDLE_NAME}.bak-")))
                .collect()
        })
        .unwrap_or_default();
    let fields = vec![
        field("ok", "true"),
        field("installed", &jb(installed)),
        field("version", &version.map(|v| jstr(&v)).unwrap_or_else(jnull)),
        field("path", &jstr(&dst.to_string_lossy())),
        field("backup_count", &backups.len().to_string()),
        field("resolve_running", &jb(resolve_running())),
        field("helper_version", &jstr(VERSION)),
    ];
    format!("{{{}}}", fields.join(","))
}

fn install(o: &Opts, dst: &Path) -> Result<String, Exit> {
    let src = o
        .source
        .as_ref()
        .ok_or_else(|| Exit::Usage("install requires --source <OFX bundle>".into()))?;
    if !bundle_looks_complete(src) {
        return Err(Exit::Fail(format!(
            "source does not look like the product bundle: {}",
            src.display()
        )));
    }
    if !o.skip_verify {
        verify_signature(src, &o.team).map_err(Exit::Fail)?;
    }
    if resolve_running() && !o.allow_resolve_running {
        return Err(Exit::Fail(
            "DaVinci Resolve is running — quit it before installing the plugin".into(),
        ));
    }
    if !o.root.is_dir() {
        return Err(Exit::Fail(format!(
            "plugin directory missing: {} (is Resolve installed?)",
            o.root.display()
        )));
    }

    let backup = if dst.exists() { Some(backup_path(dst)) } else { None };
    let used_admin = !parent_writable(&o.root);

    let mut script = String::from("set -e; ");
    if let Some(b) = &backup {
        script.push_str(&format!(
            "/bin/mv {} {} ; ",
            shell_quote(&dst.to_string_lossy()),
            shell_quote(&b.to_string_lossy())
        ));
    }
    script.push_str(&format!(
        "/usr/bin/ditto {} {}",
        shell_quote(&src.to_string_lossy()),
        shell_quote(&dst.to_string_lossy())
    ));

    if used_admin {
        run_admin(&script).map_err(Exit::Fail)?;
    } else {
        // Unprivileged path (tests / dev): same operations, no dialog.
        if let Some(b) = &backup {
            fs::rename(dst, b).map_err(|e| Exit::Fail(format!("backup move failed: {e}")))?;
        }
        let st = Command::new("/usr/bin/ditto")
            .arg(src)
            .arg(dst)
            .status()
            .map_err(|e| Exit::Fail(format!("ditto failed to start: {e}")))?;
        if !st.success() {
            return Err(Exit::Fail("ditto copy failed".into()));
        }
    }

    // Post-verify: the installed copy must be complete and carry the version.
    if !bundle_looks_complete(dst) {
        return Err(Exit::Fail(
            "install finished but the installed bundle is incomplete".into(),
        ));
    }
    let version = read_version(dst);

    // VSScript runtime registration (user-level TOML; needs the embedded
    // python from the bundle). Failure is reported, not fatal: the bundle is
    // installed and functional; registration affects the vsscript CLI path.
    let (toml_ok, toml_out): (bool, String) = if let Some(h) = &o.toml_helper {
        let py = src
            .join("Contents/Frameworks/Python.framework/Versions/Current/bin/python3")
            .exists()
            .then(|| {
                src.join("Contents/Frameworks/Python.framework/Versions/Current/bin/python3")
            })
            .or_else(|| {
                let p = dst.join("Contents/Frameworks/Python.framework/Versions/Current/bin/python3");
                p.exists().then_some(p)
            });
        match py {
            Some(py) => match Command::new(&py).arg(h).arg("--bundle").arg(dst).output() {
                Ok(r) => (
                    r.status.success(),
                    format!(
                        "{}{}",
                        String::from_utf8_lossy(&r.stdout),
                        String::from_utf8_lossy(&r.stderr)
                    )
                    .trim()
                    .to_string(),
                ),
                Err(e) => (false, format!("python failed to start: {e}")),
            },
            None => (false, "embedded python not found in the bundle".to_string()),
        }
    } else {
        (false, "no --toml-helper supplied; runtime registration skipped".to_string())
    };

    let fields = vec![
        field("ok", "true"),
        field("action", &jstr("install")),
        field(
            "installed_version",
            &version.map(|v| jstr(&v)).unwrap_or_else(jnull),
        ),
        field(
            "backup",
            &backup
                .map(|b| jstr(&b.to_string_lossy()))
                .unwrap_or_else(jnull),
        ),
        field("used_admin", &jb(used_admin)),
        field("toml_ok", &jb(toml_ok)),
        field("toml_output", &jstr(&toml_out)),
        field("path", &jstr(&dst.to_string_lossy())),
    ];
    Ok(format!("{{{}}}", fields.join(",")))
}

fn uninstall(o: &Opts, dst: &Path) -> Result<String, Exit> {
    if !dst.exists() {
        let fields = vec![
            field("ok", "true"),
            field("action", &jstr("uninstall")),
            field("removed", "false"),
            field("note", &jstr("nothing installed")),
        ];
        return Ok(format!("{{{}}}", fields.join(",")));
    }
    if resolve_running() && !o.allow_resolve_running {
        return Err(Exit::Fail(
            "DaVinci Resolve is running — quit it before removing the plugin".into(),
        ));
    }
    let b = backup_path(dst);
    let used_admin = !parent_writable(&o.root);
    if used_admin {
        let script = format!(
            "set -e; /bin/mv {} {}",
            shell_quote(&dst.to_string_lossy()),
            shell_quote(&b.to_string_lossy())
        );
        run_admin(&script).map_err(Exit::Fail)?;
    } else {
        fs::rename(dst, &b).map_err(|e| Exit::Fail(format!("remove failed: {e}")))?;
    }
    let fields = vec![
        field("ok", "true"),
        field("action", &jstr("uninstall")),
        field("removed", "true"),
        field("backup", &jstr(&b.to_string_lossy())),
        field("used_admin", &jb(used_admin)),
    ];
    Ok(format!("{{{}}}", fields.join(",")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_json_strings() {
        assert_eq!(json_escape("a\"b\\c\nd"), "a\\\"b\\\\c\\nd");
    }

    #[test]
    fn shell_quote_handles_apostrophes() {
        assert_eq!(shell_quote("/a'b c"), "'/a'\\''b c'");
    }

    #[test]
    fn version_parses_from_plist() {
        let dir = std::env::temp_dir().join(format!("vsres-plist-{}", std::process::id()));
        let c = dir.join("Contents");
        fs::create_dir_all(&c).unwrap();
        fs::write(
            c.join("Info.plist"),
            "<?xml version=\"1.0\"?><plist><dict>\n<key>CFBundleVersion</key><string>9.9.9</string>\n</dict></plist>",
        )
        .unwrap();
        assert_eq!(read_version(&dir).as_deref(), Some("9.9.9"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn skip_verify_requires_custom_root() {
        let a = vec!["status".to_string()];
        assert!(matches!(parse(&a), Ok(_)));
        let b = vec!["install".to_string(), "--skip-verify".to_string()];
        assert!(matches!(parse(&b), Err(Exit::Usage(_))));
        let c = vec![
            "install".to_string(),
            "--skip-verify".to_string(),
            "--root".to_string(),
            "/tmp/x".to_string(),
        ];
        assert!(matches!(parse(&c), Ok(_)));
    }
}
