# D2R TooltipEditor

A portable text and tooltip editor for Diablo II: Resurrected.

## Download

Download the latest Windows build from **GitHub Releases**.

- GitHub Releases: https://github.com/4KMong/D2RTooltipEditor/releases
- Nexus Mods: https://www.nexusmods.com/games/diablo2resurrected/mods/1202
- Inven: https://www.inven.co.kr/board/diablo2/5842/7628

The application is portable. No installer is required.

## Features

- Synchronized visual editor and raw D2R color-code view
- Multi-document tabs
- Find and replace across all open tabs
- D2R font-color copy and paste
- Unicode glyph browser with favorites and zero-width character tools
- Tab-width visualization and restoration
- Large-text editing support
- Optional Windows `.txt` context-menu integration
- Korean and English UI

## Requirements

- Windows 10/11 x64
- Microsoft Edge WebView2 Runtime

## About Fonts

The built-in font set is intentionally limited to the unmodified vanilla D2R fonts **Kodia** and **BlizzardGlobalTCUnicode**. They are included as a baseline for the game's default text and can also be extracted from a local game installation with tools such as CASCView.

Some custom fonts commonly encountered in D2R modding contain additional glyphs mapped to Unicode **Private Use Area (PUA)** code points. Because the origin and redistribution permissions of modified font files can be unclear, TooltipEditor does not bundle those custom variants. If a character in the Unicode glyph browser appears blank, install a font that contains the required glyph and select it from the font list, or set it as the default font in **Preferences**.

## Asset References

- `dong.wav` — modified from the Pixabay sound effect: https://pixabay.com/ko/sound-effects/%EC%98%81%ED%99%94-%EB%B0%8F-%ED%8A%B9%EC%88%98-%ED%9A%A8%EA%B3%BC-alert-234711/
- `embedded_vanilla.ttf` — unmodified Diablo II: Resurrected vanilla asset from `data:data\hd\ui\fonts\kodia.ttf`
- `embedded_fallback.ttf` — unmodified Diablo II: Resurrected vanilla asset from `data:data\hd\ui\fonts\blizzardglobaltcunicode.ttf`

## Source Build

D2R TooltipEditor is built with Tauri 2 and Rust.

```text
npm install --global @tauri-apps/cli@2.11.4
tauri build --no-bundle
```

## Version

Current release: **1.0.0**

> The distributed executable is not signed with a commercial Windows code-signing certificate, so Windows SmartScreen may display a warning.
