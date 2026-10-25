// Stamps the git commit this engine is built from into the binary (owner 2026-10-26): the startup log prints it and
// GET /health answers it in the x-vyx-engine-commit header, so the running build on the VPS can be read directly.
// VYX_GIT_COMMIT in the environment wins (a build outside a checkout); otherwise `git rev-parse HEAD`, with "-dirty"
// when tracked files differ from that commit; "unknown" when neither is available. Never fails the build.
use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn main() {
    println!("cargo:rerun-if-env-changed=VYX_GIT_COMMIT");
    let commit = match std::env::var("VYX_GIT_COMMIT") {
        Ok(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => match git(&["rev-parse", "HEAD"]) {
            Some(sha) if !sha.is_empty() => {
                let dirty = git(&["status", "--porcelain", "--untracked-files=no"]).is_some_and(|s| !s.is_empty());
                if dirty { format!("{sha}-dirty") } else { sha }
            }
            _ => "unknown".to_string(),
        },
    };
    // rebuild when HEAD moves (a checkout of another commit) or the branch it points at gets a new commit
    if let Some(head) = git(&["rev-parse", "--path-format=absolute", "--git-path", "HEAD"]) {
        println!("cargo:rerun-if-changed={head}");
        if let Some(r) = git(&["symbolic-ref", "-q", "HEAD"]) {
            if let Some(p) = git(&["rev-parse", "--path-format=absolute", "--git-path", &r]) {
                println!("cargo:rerun-if-changed={p}");
            }
        }
    }
    if let Some(index) = git(&["rev-parse", "--path-format=absolute", "--git-path", "index"]) {
        println!("cargo:rerun-if-changed={index}");
    }
    println!("cargo:rustc-env=VYX_GIT_COMMIT={commit}");
}
