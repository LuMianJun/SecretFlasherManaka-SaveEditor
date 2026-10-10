# SecretFlasherManaka 存档编辑器

适用于 **SecretFlasherManaka** 的 Windows 独立存档编辑工具。

直接打开游戏的 `.sd` 存档，按中文分类查看和修改内容，再保存为游戏使用的加密格式。无需安装 MOD，也不依赖 BepInEx；所有存档处理均在本地完成。

## 功能

- 按分类编辑 RP、玩家状态、任务、物品、装备、技能、强化、场景、历史统计、角色外观和设置。
- 已收录的物品、装备、强化效果等显示中文名称；振动模式等枚举按实际含义选择。
- 支持搜索、撤销、改动清单，以及还原到最近打开或保存时的内容。
- 角色自定义和设置中的数据表默认收起，需要时展开编辑。
- 提供完整原始结构视图，支持编辑未知字段，以及新增、删除对象或列表条目。
- 支持保存、另存为和存档槽位 ID 校验。

工具使用 **Tauri + Rust + TypeScript + CSS**，复用系统 WebView2，前端与名称数据嵌入单个 EXE，无需 Python。

## 使用方法

运行 `SecretFlasherManakaSaveEditor.exe`，点击右上角的“打开存档”。打开和另存为默认定位到游戏存档目录：

```text
%USERPROFILE%\AppData\LocalLow\SheableSoft\SecretFlasherManaka\SaveData
```

选择字段，在右侧修改后点击“暂存修改”。暂存只修改工具中的数据；点击“保存”时，也会提交当前字段尚未暂存的输入。

- **保存**：确认文件、存档 ID 和修改数量后，覆盖当前文件。
- **另存为**：选择目标位置后写入；已有文件由文件对话框确认覆盖。保存成功后，新位置成为当前文件。
- **快捷键**：`Ctrl+S` 保存，`Ctrl+Shift+S` 另存为。

保存会覆盖选定文件，不自动生成备份，请自行保留需要的原始存档。

## 存档与保存规则

| 文件 | 内容与校验 |
| --- | --- |
| `0.sd`～`19.sd` | 手动存档，内部槽位 ID 必须与文件名编号一致。 |
| `a0.sd`～`a2.sd` | 自动存档，文件编号表示轮换位置，不要求等于内部槽位 ID。 |
| `i.sd`、`h.sd` | 中断存档、回家存档，按进度存档处理。 |
| `s.sd` | 系统存档，包含设置、教程和存档列表，不使用进度槽位 ID。 |

覆盖已有文件时，存档类型和内部槽位 ID 必须一致。另存到其他手动槽位前，需要自行调整内部槽位 ID；工具不会自动更改。

工具保留原始存档结构，仅替换编辑范围，保留未修改字段、小数精度、原版类型信息和未知内容。保存时核对加密、解密后的内容，在目标目录写入临时文件并验证，再替换目标文件。

存档中的可用 RP、累计 RP、待结算 RP 和历史记录是独立字段，工具不会自动同步。修改后的字段组合是否符合游戏运行逻辑，仍取决于原版规则。

## 从源码构建

需要 Windows x64、Rust stable、Node.js 18+、MSVC C++ Build Tools 和 Windows SDK。运行工具需要 Microsoft Edge WebView2 Runtime。

在 Visual Studio 开发者 PowerShell 中执行：

```powershell
cd tauri
npm ci
npm --prefix ui ci
npm run build
```

生成的程序位于：

```text
tauri/src-tauri/target/release/SecretFlasherManakaSaveEditor.exe
```

开发模式使用 `npm run dev`。项目另提供根目录的 `build.ps1` 打包脚本，默认查找 Visual Studio 2022 Build Tools 和 Windows SDK 的标准安装位置。

## 项目结构

```text
tauri/
  ui/             TypeScript 界面、样式与中文名称数据
  src-tauri/      Rust 存档解析、加解密、校验与桌面入口
  metadata.json   字段分类元数据
format_config.json  存档格式配置
build.ps1           本地打包脚本
```
