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
- Unicode glyph browser with favorites, edit mode, and zero-width character tools
- Tab-width visualization and restoration
- Large-text editing support
- Optional Windows `.txt` context-menu integration
- Korean and English UI

## Important: Fonts and Unicode Glyphs

> **Do not panic if some favorite characters in the Unicode Input window appear as squares or blank characters.**

TooltipEditor intentionally bundles only the unmodified vanilla D2R fonts **Kodia** and **BlizzardGlobalTCUnicode**.

Some custom fonts used in the D2R modding community place extra glyphs in Unicode **Private Use Area (PUA)** code points. The default favorites in the Unicode Input window include addresses from ranges that are commonly used for this kind of custom glyph mapping. Those addresses may therefore appear as a square or blank character when viewed with an unmodified vanilla font that does not contain the corresponding glyph.

Modified community fonts are not bundled with TooltipEditor because their original source and redistribution permissions are not always clear. Only vanilla fonts that can be extracted directly from the game are included.

If you want to use PUA glyphs:

- Install a font that actually contains the required glyphs in Windows.
- Select that font from TooltipEditor's font list.
- If you use it frequently, set it as the default font in **Preferences**.
- Unicode favorites can be exported and imported, so you can keep your own glyph-address list separately.

The vanilla-font preview in the Unicode Input window is intended as a reference for how a code point behaves with the built-in vanilla font set. A missing glyph is not automatically replaced with a community font.

## Practical Usage Notes

### 1. Opening and saving `.txt` files

TooltipEditor is designed to work directly with D2R tooltip `.txt` files.

When display-setting saving is enabled, TooltipEditor stores its display metadata at the end of the text file so that settings such as font and layout can be restored when the file is opened again. Removing that metadata block may prevent those display settings from being restored later.

TooltipEditor does not force itself to become the Windows default application for `.txt` files. If you want quicker access, enable **Windows Shell Menu** in **Preferences** to add **Open with D2R Tooltip Editor** to the Windows right-click menu for `.txt` files.

### 2. Useful shortcuts

- Select text and press **Ctrl+Alt+[color character]** to apply the mapped D2R color. Example: `Ctrl+Alt+2` applies the color mapped to `ÿc2`.
- **Ctrl+Shift+C** copies the font color of the first character in the current Editor selection.
- **Ctrl+Shift+V** applies that copied font color to the selected text.

If a selected block contains multiple colors, the color-copy command uses the color of the first character in the selection.

### 3. JSON Key Extraction

The menu includes **Extract JSON Key**, which can reduce pasted JSON content to the values for a selected language key. This is useful when preparing or reviewing D2R localization text.

### 4. Korean-community `@Myc` compatibility

The **Replace** window (`Ctrl+H`) includes a `ÿc ↔ @Myc` preset.

It fills the Find/Replace fields with `ÿc` and `@Myc`; pressing it again reverses the direction. This is intended as a compatibility helper for **Korabi-style `@Myc` color aliases used in parts of the Korean D2R modding community**. `@Myc` is not an official D2R notation.

When converting these aliases, enable **Keep `ÿc0` in Code Pane** if you need explicit white/default-color markers to remain after conversion. Depending on how a specific mod uses `@Myc`, a perfectly lossless round-trip conversion is not guaranteed.

### 5. About zero-width characters (`U+2060`)

Using a zero-width character to trigger a fallback font is a workaround rather than an official D2R text-format feature. Its behavior can vary depending on the font and implementation, and malformed or unsupported Unicode may appear incorrectly in game.

Use the `U+2060` tools carefully and verify the result in your actual mod/game setup.

### 6. Editor/Code scroll synchronization

The **Editor** pane is the primary editing surface. The **Code** pane is mainly a reference view for raw color codes and special characters.

Scroll Sync tries to keep both panes near the same logical area, but it should be treated as an approximate navigation aid rather than exact cursor-position synchronization.

### 7. Editor copy options

The Editor copy options can always be reset with the **Default** button.

By default, copied text can preserve the normal tooltip-code form. If you want cleaner plain-text output, you can change the copy options to:

- exclude color-code symbols,
- copy line breaks as real line breaks,
- copy Unicode as actual glyphs or as Unicode escape strings.

These options affect clipboard output only; they do not rewrite the document merely by changing the copy settings.

## Requirements

- Windows 10/11 x64
- Microsoft Edge WebView2 Runtime

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
