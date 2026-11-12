# ffmpeg encoder helper — recipient rebuild kit (draft)

**What this is.** The render queue encodes with the app-owned ffmpeg at
`runtime/ffmpeg/ffmpeg`, but this project never redistributes its own dev
builds. What ships next to the binary is the *route to rebuild it yourself*
from the pinned official source:

- `manifest.json` — the exact inputs and configuration of the shipped binary
  (source URL + archive/signature hashes + signing-key fingerprint, configure
  flags, binary hash, material hashes).
- `materials/` — the full source archive, its detached signature, the
  release public key, the signature-verification receipt, `LICENSE.md`,
  `COPYING.LGPLv2.1`, and the build records (`config.mak`, `config.log`,
  invocation).
- `recipient/rebuild_ffmpeg_encoder.py` — a recipe that verifies the archive
  against FFmpeg's release signature and recompiles the helper. It installs
  nothing and launches nothing; it needs its own admitted build allowance.

## The shipped configuration (configure-verified)

```
--arch=arm64 --target-os=darwin --cc=<clang> --host-cc=<clang>
--pkg-config=/usr/bin/false --disable-shared --enable-static
--disable-ffprobe --disable-ffplay --disable-doc --disable-debug
--disable-checkasm --disable-autodetect --disable-network
--disable-devices --disable-avdevice
--disable-gpl --disable-nonfree --disable-version3
```

`configure` prints **"License: LGPL version 2.1 or later"** for this flag
set; no external codec libraries are enabled (no x264/x265/lame/etc.). The
helper loads only Apple system frameworks (CoreFoundation, CoreMedia,
CoreVideo, libSystem) and targets macOS 13.0.

## Rebuild

```sh
python3 rebuild_ffmpeg_encoder.py \
    --materials  <this kit dir> \
    --output     <new empty directory> \
    --developer-dir "$(xcode-select -p)" \
    --gpg        /opt/homebrew/bin/gpg
```

The recipe re-verifies the GPG signature before compiling and records every
step under `records/`. A completed rebuild is *unqualified*: comparing the
resulting hash against `manifest.json` is the recipient's acceptance step.

## Honest scope

This describes a configuration, not a legal opinion: source/relink/notice,
patent and final distribution review remain open items for the owner (see
`docs/SBOM.md`, "November 12 ffmpeg ENCODER candidate"). The encoder binary
is a separate process reached only through the render queue — it is not part
of the OFX plugin and never loads inside DaVinci Resolve.
