<h1 align="center">VapourSynth for Resolve</h1>

<p align="center">
  VapourSynth restoration filters on a node in DaVinci Resolve.<br>
  Build the chain visually, check it against scopes, render it in Resolve.
</p>

<h3 align="center">
  <a href="https://github.com/Hank-tha-Cowdog/VapourSynth4Resolve/releases/download/v2.0.0-alpha.0/VapourSynth.Companion-2.0.0-alpha.0-arm64.dmg">Download for macOS</a> <sup>alpha</sup>
</h3>

<p align="center">
  <sub>Apple Silicon &nbsp;·&nbsp; macOS 26 or later &nbsp;·&nbsp; DaVinci Resolve 21 &nbsp;·&nbsp; free and open source</sub>
</p>

<p align="center">
  <a href="#install">Install</a>
  &nbsp;·&nbsp;
  <a href="#use">Use</a>
  &nbsp;·&nbsp;
  <a href="#skippy-the-scripting-assistant">Skippy</a>
  &nbsp;·&nbsp;
  <a href="#build-from-source">Build from source</a>
</p>

![The companion app: a processed frame beside RGB parade scopes, with the filter library on the left](docs/images/preview-scopes.png)

<p align="center">
  <sub>The Preview tab: the processed frame beside scopes measured from the same signal.</sub>
</p>

## What it is

[VapourSynth](https://www.vapoursynth.com) is a video processing framework with some of the best restoration filters there are: QTGMC deinterlacing, BM3D denoising and many more. Normally, using it means writing Python scripts.

VapourSynth for Resolve puts those filters on a node in Resolve's Color page. It has two parts:

- **The OFX plugin** runs your filter chain inside Resolve.
- **The companion app** is where you build the chain. Pick filters from a library, adjust them, preview the result, then send it back to the node.

There is nothing else to set up. Python, VapourSynth and a curated set of filter plugins are built in.

For anything the library does not cover, you can add your own script step, and [Skippy](#skippy-the-scripting-assistant), the built-in assistant, helps you write it.

## A quick tour

### Chain

Add filters from the library and set them with ordinary controls. Steps are arranged in a sensible restoration order for you, and every step shows the script it produces.

![The Chain tab with a levels step and a QTGMC deinterlace step](docs/images/filter-chain.png)

### Pipeline

The whole path on one page: source, input conversion, each filter in order, and the output back to Resolve, with color space and gamma labels at every stage.

![The Pipeline tab showing the signal path from source file to Resolve output](docs/images/pipeline-flow-map.png)

### Script

The exact VapourSynth script the node runs, section by section. Nothing is hidden.

![The Script tab showing the composed VapourSynth script](docs/images/script-redacted.png)

## Install

You need an Apple Silicon Mac on macOS 26 or later, and DaVinci Resolve 21.

1. **Download** [VapourSynth for Resolve for macOS](https://github.com/Hank-tha-Cowdog/VapourSynth4Resolve/releases/download/v2.0.0-alpha.0/VapourSynth.Companion-2.0.0-alpha.0-arm64.dmg). It is a `.dmg` file and lands in your Downloads folder.
2. **Open the `.dmg`** and drag VapourSynth Companion onto the Applications folder.
3. **Open the app once** from Applications. macOS asks you to confirm the first time; click **Open**.
4. **Add the plugin to Resolve.** Quit Resolve, open the Terminal app, paste this and press Return. It asks for your Mac password, and nothing shows while you type it.

   ```sh
   sudo mkdir -p /Library/OFX/Plugins && sudo cp -R \
     "/Applications/VapourSynth Companion.app/Contents/Resources/OFX/VapourSynth.ofx.bundle" \
     /Library/OFX/Plugins/
   ```

5. **Start Resolve.** VapourSynth is now in the OpenFX library on the Color page.

To update, delete `/Library/OFX/Plugins/VapourSynth.ofx.bundle` and repeat step 4 with the new version. Older versions are on the [releases page](https://github.com/Hank-tha-Cowdog/VapourSynth4Resolve/releases).

## Use

1. On the **Color** page, open **OpenFX**, find **VapourSynth** and drag it onto a node.
2. In the node's settings, click **Configure…** The companion app opens on that clip.
3. In **Chain**, add filters from the library and adjust them.
4. In **Preview**, switch between **Source** and **Chain** and read the scopes.
5. Click **Save and close**. The chain is applied to the node and Resolve renders it.

To change the chain later, click **Configure…** again.

A few things worth knowing:

- **Mix** on the node blends the filtered result with the original.
- **Manual Order** lets you arrange the steps yourself instead of using the automatic order.
- **Recipes** saves a chain so you can reuse it on other clips.
- **Source file.** Restoration filters work best when they read the original media file. If the app does not pick it up by itself, click **Identify source…** or drop the file in from Finder.
- **Script steps run real Python on your Mac.** They only run once you approve them, so read a script before you approve it, including anything a recipe or Skippy proposes.

## Skippy, the scripting assistant

Not every fix is in the filter library. A **Script** step runs your own VapourSynth code, and Skippy is there to help you write it. Describe the problem in plain words and Skippy drafts the step, with comments that explain each line.

For example, you type:

> This VHS capture has a band of flickering noise along the bottom edge. Can you hide it?

Skippy adds a Script step like this to your chain:

```python
# VHS decks switch heads near the bottom of the picture, which leaves a band
# of torn, flickering lines. Cut those 8 lines off...
clip = core.std.Crop(clip, bottom=8)

# ...then add 8 black lines back, so the frame keeps its size and the rest
# of the chain sees the same resolution. 4096 is video black at 16 bits.
clip = core.std.AddBorders(clip, bottom=8, color=[4096, 32768, 32768])
```

The step arrives unapproved. Read it, click **Approve**, and check the result in **Preview**. If it is not right, say what to change ("make it 12 lines") and Skippy updates the same step. It can also explain what a filter or setting does, and help work out why a script fails.

Skippy is optional, and everything else works without it. It needs a model to talk to: your own API key (Anthropic, OpenAI, Google Gemini, OpenRouter or xAI) or a local model through LM Studio or Ollama. Keys are stored in the macOS Keychain. With Anthropic models Skippy edits the chain directly. With the other providers it answers with code that you paste into a Script step yourself. See [provider settings](docs/llm-providers.md).

## Build from source

You need Xcode, Homebrew (for `zimg` and Python 3.12 or later), CMake 3.24 or later, and Node 24.

```sh
scripts/build-vapoursynth.sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DVSRES_VS_PREFIX="$PWD/vendor/vapoursynth/active"
cmake --build build
cd companion-app && npm ci && npm run build
```

This builds the plugin and the app for development. Making the self-contained bundle and the DMG is covered in [packaging](docs/packaging.md). See also [building on macOS](docs/building-macos.md) and [architecture](docs/architecture.md).

## Status

This is an early alpha.

- It runs on macOS with Apple Silicon only. Windows and Linux are planned.
- It has not been widely tested on other people's Macs yet, so expect rough edges.
- Try it on test projects and copies of your media first.

Known limitations are listed in the [release notes](docs/release-notes-2.0.0-alpha.0.md). Found a bug? [Open an issue](https://github.com/Hank-tha-Cowdog/VapourSynth4Resolve/issues) with your macOS and Resolve versions and the steps to reproduce it. Please leave out private footage and API keys.

## License

The OFX plugin is [GPLv3](LICENSE). The companion app is [MIT](companion-app/LICENSE). Bundled third-party components keep their own licenses; see the [notices index](docs/notices-index.md) and [SBOM](docs/SBOM.md).

## Credits

This project began as a tool for the restoration of Bruce Lee's *Game of Death*. [Read the story](https://zacharymakes.com/projects/vapoursynth-davinci-plugin).

Thanks to **Xappio Inc.** for their contributions and support in this release.

- VapourSynth and the original Windows OFX plugin: Fredrik Mellbin and contributors
- v2 and the companion app: Hank-tha-Cowdog
- Companion shell: VapourSage
- OpenFX: Academy Software Foundation and contributors
- BM3DMETAL: Sunflower-Dolls
- vs-mlrt: AmusementClub
- Every filter, helper and runtime author keeps their own credits and notices
