//! Integration tests for vsres-install against a synthetic bundle + temp root.
//! No admin, no codesign, no Resolve interaction: exercises the unprivileged
//! paths (install/backup/uninstall/status) exactly as the companion drives them.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_vsres-install")
}

fn run(args: &[&str]) -> (i32, String) {
    let out = Command::new(bin())
        .args(args)
        .output()
        .expect("spawn vsres-install");
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.code().unwrap_or(-1), stdout)
}

fn make_fake_bundle(dir: &Path, version: &str) -> PathBuf {
    let b = dir.join("source/VapourSynth.ofx.bundle");
    fs::create_dir_all(b.join("Contents/MacOS")).unwrap();
    fs::write(b.join("Contents/MacOS/VapourSynth.ofx"), b"fake").unwrap();
    fs::write(
        b.join("Contents/Info.plist"),
        format!("<plist><dict><key>CFBundleVersion</key><string>{version}</string></dict></plist>"),
    )
    .unwrap();
    b
}

fn temp_root(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("vsres-install-it-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(d.join("plugins")).unwrap();
    d
}

#[test]
fn full_lifecycle() {
    let root_dir = temp_root("life");
    let root = root_dir.join("plugins");
    let src = make_fake_bundle(&root_dir, "9.9.9");
    let root_s = root.to_str().unwrap();
    let src_s = src.to_str().unwrap();

    // status: not installed
    let (code, out) = run(&["status", "--root", root_s]);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("\"installed\":false"), "{out}");

    // install
    let (code, out) = run(&[
        "install", "--root", root_s, "--source", src_s,
        "--skip-verify", "--allow-resolve-running",
    ]);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("\"ok\":true"), "{out}");
    assert!(out.contains("9.9.9"), "{out}");
    assert!(out.contains("\"used_admin\":false"), "{out}");
    assert!(root.join("VapourSynth.ofx.bundle/Contents/MacOS/VapourSynth.ofx").is_file());

    // second install -> backup of first
    let (code, out) = run(&[
        "install", "--root", root_s, "--source", src_s,
        "--skip-verify", "--allow-resolve-running",
    ]);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("\"backup\":\""), "{out}");
    let backups = fs::read_dir(&root)
        .unwrap()
        .filter(|e| {
            e.as_ref()
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".bak-")
        })
        .count();
    assert_eq!(backups, 1, "expected exactly one backup");

    // status: installed with version + backup count
    let (code, out) = run(&["status", "--root", root_s]);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("\"installed\":true"), "{out}");
    assert!(out.contains("\"version\":\"9.9.9\""), "{out}");
    assert!(out.contains("\"backup_count\":1"), "{out}");

    // uninstall
    let (code, out) = run(&["uninstall", "--root", root_s, "--allow-resolve-running"]);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("\"removed\":true"), "{out}");
    assert!(!root.join("VapourSynth.ofx.bundle").exists());

    // uninstall again: idempotent
    let (code, out) = run(&["uninstall", "--root", root_s, "--allow-resolve-running"]);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("\"removed\":false"), "{out}");

    let _ = fs::remove_dir_all(&root_dir);
}

#[test]
fn refuses_bad_source_and_bad_usage() {
    let root_dir = temp_root("bad");
    let root = root_dir.join("plugins");
    let root_s = root.to_str().unwrap();

    // missing --source
    let (code, _out) = run(&["install", "--root", root_s, "--skip-verify"]);
    assert_eq!(code, 64);

    // nonexistent source
    let (code, out) = run(&[
        "install", "--root", root_s, "--source", "/nonexistent/ofx.bundle", "--skip-verify",
    ]);
    assert_eq!(code, 2, "{out}");
    assert!(out.contains("does not look like"), "{out}");

    // unknown flag
    let (code, _out) = run(&["status", "--wat"]);
    assert_eq!(code, 64);

    let _ = fs::remove_dir_all(&root_dir);
}
