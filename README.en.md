[简体中文](README.md) · [繁體中文](README.zh-TW.md) · **English** · [日本語](README.ja.md) · [한국어](README.ko.md)

# SecretFlasherManaka Save Editor

A standalone Windows save editor for **SecretFlasherManaka**.

Open the game's `.sd` files, browse and edit their contents by category, and save them in the game's encrypted format. No MOD or BepInEx installation is required. All save processing happens locally.

Downloads and release notes: [GitHub Releases](https://github.com/LuMianJun/SecretFlasherManaka-SaveEditor/releases).

## Features

- Edit RP, progression, mission history, items, equipment, skills, reinforcement, map unlocks and lifetime statistics.
- The default **Common** category groups available RP, exposure experience, items, maximum detection tolerance, adult toy reinforcement and costume part reinforcement. These are the same fields shown in their original categories.
- Known items, equipment and reinforcement effects use the original names for the selected interface language. Numeric options such as vibration modes have descriptive choices.
- Original mission records show `【Map】Mission name` and can be searched by map name. Drone records grouped by map also show the map; aggregate drone counts remain totals across maps.
- Skill levels use each skill's original maximum. Direct numeric edits are range-checked; existing out-of-range values are not changed automatically.
- Difficulty offers the original game's enabled Easy and Original options. Time of day is shown as day or night.
- Search, undo, a change list, and reverting to the last opened or saved state are supported.
- Appearance, presets, shortcuts, mode settings, read tutorial records and some detailed records are collapsed by default and can be expanded.
- Current mission progress, pending earnings, transient state, scene data, slot-list summaries, legacy casual-clothing reinforcement and auxiliary hint markers are hidden by default. Category counts and search also exclude these fields.
- Unknown IDs in selected skill, reinforcement and clothing name tables are hidden while their raw data is preserved. Unknown mission records remain visible and explicitly report that their names are not stored in the save.
- The **Raw data** view includes unknown fields and supports adding or deleting object and list entries.
- Save, Save as and save-slot ID checks are supported.
- Saving a manual slot updates that slot's rank, save time, difficulty and play time in `s.sd` in the same folder, fixing stale or default information in the game's load list.
- Field explanations highlight relevant loading resets, conditional effects and unavailable names.

Built with **Tauri + Rust + TypeScript + CSS**, using the system WebView2 runtime. The interface and name data are embedded in one EXE. Python is not needed to run the editor.

## Interface language

The globe button in the upper right switches between Simplified Chinese, Traditional Chinese, English, Japanese and Korean—the same five language options as the game. With no saved preference, the interface defaults to Chinese and opens a language picker using each language's own name. After an explicit choice, the editor remembers it and does not prompt on subsequent launches. Changing language preserves the open save, unapplied input and browsing state. It does not change the game's language setting or any other save field.

Items, skills, costumes, missions, maps and achievements use the corresponding columns of the original game dictionary. Mission locations, distances and achievement conditions follow the original master data and name-formatting rules; they are not translated back from Chinese. Some old records use Japanese literals without translation keys; these retain their original text. Editor-specific controls, explanations and repair messages are translated separately.

See [Languages and original names](docs/多语言与原版名称.md) for sources and update instructions. This detailed reference is in Simplified Chinese.

## Usage

Run `SecretFlasherManakaSaveEditor.exe` and click **Open save** in the upper right. Open and Save as default to the game's save folder:

```text
%USERPROFILE%\AppData\LocalLow\SheableSoft\SecretFlasherManaka\SaveData
```

Select a field, edit it on the right, and click **Apply edit**. This changes data only inside the editor. Clicking **Save** also applies any pending input in the currently selected field.

- **Save**: after confirmation of the file, save ID and change count, overwrite the current file.
- **Save as**: suggest the first unused slot filename in the game's save folder, or `s.sd` for a system save. Choose a destination; the file dialog confirms overwriting an existing file. On success, the new destination becomes the current file.
- **Shortcuts**: `Ctrl+S` to save; `Ctrl+Shift+S` to save as.

Normal saving overwrites the selected file without creating a backup. Keep copies of original saves you want to preserve.

## Save files and saving rules

| File | Contents and checks |
| --- | --- |
| `0.sd`–`19.sd` | Manual saves. The internal slot ID must match the filename's number. |
| `s.sd` | System save containing options, tutorial records and the save list. It has no progress-slot ID. |

When saving as `0.sd`–`19.sd`, the editor assigns the internal ID from the destination filename. Overwriting still checks the target's save type and slot. Canceling or a failed save does not change the open document's slot ID. If all 20 slots are occupied, Save as keeps the current filename as its suggestion, leaving you to choose a destination and confirm any overwrite.

If the destination folder contains `s.sd`, saving also updates the destination slot's load-list summary: rank is calculated from exposure experience, difficulty and play time come from the progress save, and save time uses the current local time. Confirmation shows the synchronization target. Re-saving an unchanged document can also refresh its summary. Other slots, global options and tutorial records are preserved. The editor does not create `s.sd` for a standalone copy, and non-slot filenames do not trigger summary synchronization. If the game is already running, restart it to read the updated summary rather than its cached copy.

The editor preserves the original save structure and replaces only the edited ranges, retaining unchanged fields, decimal precision, original type information and unknown content. Saving verifies encryption and decryption, writes and checks temporary files in the destination folder, then replaces the target files.

Hidden does not mean deleted: runtime fields remain in the save and raw fragments. They are not removed or reset simply because the interface does not show them. Available RP, total RP and historical records are separate fields and are not automatically synchronized. Whether an edited combination behaves as intended still depends on the original game's rules.

Original mission names come from the bundled original-game data. Custom mission names are usually absent from saves. The editor does not guess or hardcode those names or require external plugins; an unrecognized record is shown as “Unknown mission (ID …; name not stored in save).”

See [Save types and field behavior](docs/存档类型与字段作用.md) for detailed field scope, loading resets and save timing. This reference is in Simplified Chinese.

## Save repair — initial scope

Open a progress save and click **Repair save**. Review the “Remove mod data and restore required original data” list, then click **Apply repairs**. Applying changes only the data in the editor and can be undone as one batch. The repaired document must first be saved to another file; its source cannot be overwritten.

Repair uses bundled rules for the currently verified original fields, enums and master IDs. It does not load MOD DLLs or require individual MOD integrations. It removes extension fields and extension records from verified item, skill, mission, clothing and preset tables. Associated references in clothing ownership, options, effects, locks and every preset are handled together. Original legacy IDs and sentinel values are preserved; validity is not decided by whether the interface has a name for an ID.

Missing or malformed original data is filled using verified defaults, including three reinforcement slots, four lock switches and 20 outfit/appearance presets. Valid numeric text is preserved. Existing RP, original mission results and equipment records are not proactively recalculated. Lost real results can only be recovered from a backup; filling defaults does not restore historical progress.

This initial implementation supports progress saves that can be decrypted and parsed and have a recognizable `GameStateData` type header. A missing or invalid slot ID can be filled from a manual-slot filename. It does not repair system saves (`s.sd`), truncated files or damaged encryption, and cannot guarantee recovery from every in-game error. Old rules may treat fields from a newer game version as extensions, so review the preview. Repair removes other MODs' extension progress, including custom missions; normal opening and saving do not perform this cleanup.

## Build from source

Requires Windows x64, Rust stable, Node.js 18+, MSVC C++ Build Tools and the Windows SDK. Running the editor requires Microsoft Edge WebView2 Runtime.

In a Visual Studio developer PowerShell:

```powershell
cd tauri
npm ci
npm --prefix ui ci
npm run build
```

The executable is generated at:

```text
tauri/src-tauri/target/release/SecretFlasherManakaSaveEditor.exe
```

Use `npm run dev` for development. The root `build.ps1` packaging script looks for Visual Studio 2022 Build Tools and the Windows SDK in their standard installation locations by default.

## Project layout

```text
README*.md         Usage guides in five languages
docs/              Detailed field, repair and language references (Simplified Chinese)
tauri/
  ui/              TypeScript interface, styles and multilingual name data
  src-tauri/       Rust save parsing, encryption, validation and desktop entry point
  metadata.json    Field category metadata
format_config.json Save format configuration
build.ps1          Local packaging script
```
