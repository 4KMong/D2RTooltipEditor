# D2R TooltipEditor

A portable text and tooltip editor for Diablo II: Resurrected.

> **TooltipEditor does not directly modify in-game item tooltips.**
> It is a **tool for mod creators** that makes it easier to edit the text strings, D2R color codes, and formatting used as values in D2R mod JSON files.

## Download

Download the latest Windows build from **GitHub Releases**.

- GitHub Releases: https://github.com/4KMong/D2RTooltipEditor/releases
- Nexus Mods: https://www.nexusmods.com/games/diablo2resurrected/mods/1202
- Inven: https://www.inven.co.kr/board/diablo2/5842/7628

The application is portable. No installer is required.

## Features

- Real-time D2R tooltip preview
- D2R color-code editing and conversion
- Color formatting copy / paste
- Unicode Input with editable favorites
- Custom font selection
- Built-in vanilla D2R font preview
- Unicode favorites import / export
- JSON key extraction
- Text cleanup tools
- Multiple document tabs
- Find / Replace utilities
- D2R Editor / Code dual view
- Various copy-format options
- Tab-style spacing and alignment using character-based filler patterns
- Light / Dark themes
- Korean / English UI
- Optional Windows `.txt` context-menu integration

## Why TooltipEditor Uses Left-Aligned Tooltips by Default

TooltipEditor uses **left alignment as its default preview layout** because left-aligned tooltip text can also be implemented directly in Diablo II: Resurrected's actual UI JSON data. It is not only an editor-side visual preference.

In extracted D2R UI JSON, a tooltip-bearing UI object can define its text through `fields.tooltipString` and its rendering style through `fields.tooltipStyle`. Horizontal alignment is controlled by:

```text
fields.tooltipStyle.fontStyle.alignment.h
```

To make a tooltip left-aligned, set that value to `"left"`.

For example, a tooltip object may contain:

```json
{
  "fields": {
    "tooltipString": "@SomeTooltipKey",
    "tooltipStyle": {
      "fontStyle": {
        "alignment": {
          "h": "left",
          "v": "center"
        }
      }
    }
  }
}
```

If the object already has a `tooltipStyle`, you normally only need to change or add the horizontal alignment value rather than replacing the entire style block:

```json
"alignment": {
  "h": "left",
  "v": "center"
}
```

For multiline tooltip layouts, a style may also explicitly use standard newline handling:

```json
"tooltipStyle": {
  "fontStyle": {
    "options": {
      "newlineHandling": "standard"
    },
    "alignment": {
      "h": "left",
      "v": "center"
    }
  }
}
```

The exact UI JSON file and object depend on the panel or tooltip being modified, but the principle is the same: find the UI object that owns the `tooltipString` and apply the desired `tooltipStyle` to that object.

This is why TooltipEditor's default left-aligned preview is useful when designing structured or multiline tooltip text: the same layout can be reproduced in-game by changing the corresponding D2R UI JSON.

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

## Close Button and System Tray

By default, clicking the window **Close (X)** button minimizes TooltipEditor to the Windows system tray instead of fully exiting the program.

If you prefer the Close button to exit the application normally, disable the system-tray behavior in **Preferences**.

## Practical Usage Notes

### 1. Opening and saving `.txt` files

TooltipEditor is designed to work directly with D2R tooltip `.txt` files.

When display-setting saving is enabled, TooltipEditor stores its display metadata at the end of the text file so that settings such as font and layout can be restored when the file is opened again. Removing that metadata block may prevent those display settings from being restored later.

TooltipEditor does not force itself to become the Windows default application for `.txt` files. If you want quicker access, enable **Windows Shell Menu** in **Preferences** to add **Open with D2R Tooltip Editor** to the Windows right-click menu for `.txt` files.

### 2. Useful shortcuts

- Select text and press **Ctrl+Alt+[color key]** to apply the mapped D2R color. Example: `Ctrl+Alt+2` applies the color mapped to `ÿc2`.
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

TooltipEditor includes an option that uses the zero-width Unicode character `U+2060` to help trigger font fallback in certain D2R tooltip strings. This is a workaround rather than an officially supported D2R text-format feature, so results can vary depending on the font, Unicode character, mod setup, and game rendering behavior.

Unsupported Unicode may sometimes appear as a blank character, a replacement glyph, or `*`. Treat this as an experimental compatibility feature and verify the result in your actual mod/game setup.

Because invisible `U+2060` characters can be easy to leave in a value by mistake, TooltipEditor indicates their presence in the status bar and, by default, asks for confirmation when saving a document that still contains them. They can also be removed through **Text Cleanup**.

### 6. Tab-style spacing and alignment

D2R tooltip strings do not provide ordinary text-editor-style tab alignment, so TooltipEditor provides a visual workaround. **Implement Tabs** converts actual Tab characters into character-based filler patterns measured against the current font and tab width, then renders those fillers in black so they blend into D2R's normally dark tooltip background.

If the filler text is still noticeable with your tooltip design, a darker tooltip background can help it blend in more naturally. This is a visual workaround rather than true tab rendering, so the result can vary with the font, alignment, tooltip layout, and mod configuration. Tab implementation is intended primarily for left- or right-aligned layouts; centered layouts may not align as expected.

> **Important:** Do not leave literal Tab characters inside a final JSON string unintentionally. Depending on the file structure, they can make the JSON invalid or cause unintended behavior. TooltipEditor warns before saving documents that contain literal Tab characters by default, and **Text Cleanup** can remove or replace them.

TooltipEditor can also attempt to restore its generated tab filler patterns back to Tab characters or replace them with custom text. Exact restoration may not always be possible.

### 7. Editor/Code scroll synchronization

The **Editor** pane is the primary editing surface. The **Code** pane is mainly a reference view for raw color codes and special characters.

Scroll Sync tries to keep both panes near the same logical area, but it should be treated as an approximate navigation aid rather than exact cursor-position synchronization.

### 8. Editor copy options

The Editor copy options can always be reset with the **Default** button.

By default, copied text can preserve the normal tooltip-code form. If you want cleaner plain-text output, you can change the copy options to:

- exclude color-code symbols,
- copy line breaks as real line breaks,
- copy Unicode as actual glyphs or as Unicode escape strings.

These options affect clipboard output only; they do not rewrite the document merely by changing the copy settings.

## Project Status

TooltipEditor was created through **vibe coding with the help of ChatGPT**.

There are currently **no plans to add support for additional languages or to introduce major new features**. The program includes an in-app **Help** section with more detailed explanations of individual tools and behavior.

## Modification and Redistribution

You are free to modify and redistribute this work in any form as long as it is **not used for commercial purposes**. Please credit the original author and clearly state the source.

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
