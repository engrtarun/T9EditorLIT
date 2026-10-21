use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    // The deploy ledger needs an identity it can trust. `build.ps1` sets this
    // before `cargo` runs; a plain `cargo build` keeps "dev". The value is
    // written into OUT_DIR and included by lib.rs, so it is compiled into the
    // executable and cannot drift from the build.json marker.
    let out = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR is set by cargo"));
    let build_id = env::var("T9_BUILD_ID").unwrap_or_else(|_| "dev".to_string());
    let build_id = build_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '-'
            }
        })
        .collect::<String>();
    fs::write(
        out.join("build_id.rs"),
        format!("pub const BUILD_ID: &str = {build_id:?};\n"),
    )
    .expect("write build_id.rs");
    println!("cargo:rerun-if-env-changed=T9_BUILD_ID");

    tauri_build::build()
}
