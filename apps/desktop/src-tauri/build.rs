fn main() {
    // Sentry reads these at build time, so a change needs a rebuild.
    for name in ["JUNIOR_URL", "SENTRY_DSN", "SENTRY_ENVIRONMENT"] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    tauri_build::build()
}
