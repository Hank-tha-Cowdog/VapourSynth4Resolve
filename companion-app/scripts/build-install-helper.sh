#!/bin/bash
# Build the vsres-install helper and stage it into companion-app/resources/bin
# (electron-builder ships that dir as Resources/bin in the packaged app).
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build --release --manifest-path ../tools/vsres-install/Cargo.toml
mkdir -p resources/bin
cp ../tools/vsres-install/target/release/vsres-install resources/bin/vsres-install
echo "staged: companion-app/resources/bin/vsres-install"
