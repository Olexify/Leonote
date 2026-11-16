#!/usr/bin/env bash
# Runs inside the container. /src is the project, read-only; /out receives the result.
set -euo pipefail
rsync -a --delete \
  --exclude node_modules --exclude dist --exclude release --exclude .git \
  --exclude src-tauri/target --exclude 'src-tauri/gen' \
  /src/ /build/
cd /build
npm ci --no-audit --no-fund
npx tauri build --bundles deb,appimage
find src-tauri/target/release/bundle -type f \( -name '*.deb' -o -name '*.AppImage' \) -exec cp -v {} /out/ \;
cd /out && for f in *.deb *.AppImage; do [ -f "$f" ] && sha256sum "$f" > "$f.sha256"; done
echo "Linux build done."
