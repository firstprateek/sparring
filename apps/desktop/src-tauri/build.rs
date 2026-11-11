fn main() {
    println!("cargo:rerun-if-env-changed=SPARRING_DAEMON_URL");
    tauri_build::build()
}
