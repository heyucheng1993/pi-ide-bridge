# Pi IDE Bridge

Pi 扩展，用于把 IDE（VS Code、Cursor、Trae）和 Pi 编程助手连接起来。

[English](README.md)

## 附件预览

文件和代码选区显示为输入框上方的附件标签（例如 `[example.c ×]`、`[example.c 10:25 ×]`），不再直接粘贴到输入框。悬停可预览，点击红色 `×` 可单独移除；终端选区仍直接粘贴。

- `/ide-preview [编号]`：预览附件。
- `/ide-remove-attachment [编号]`：移除一个附件。
- `/ide-clear-attachments`：清空待发送附件。
- 附件随下一条用户消息发送，之后标签清空。重载或切换会话前请先发送或清除附件。
- 鼠标操作需要 Pi 全屏模式和终端鼠标支持；普通模式可使用上述命令。
- 需要 Pi / pi-tui 1.5.2 或更新版本。配套扩展源码包含准确的选区文件名和行号。

请先停用其他重复加载的 bridge 扩展。构建配套 VSIX 和运行测试的方法见 [English README](README.md#development)。旧版配套扩展仍可使用，但附件标签中的文件名和行号会回退到缓存的 IDE 状态。请使用匹配的配套扩展版本；测试尚未发布的修改时，可从源码构建配套 VSIX，`/ide init` 下载的始终是最新已发布版本。

## 主要功能

- **默认仅发送显式附件**：文件和选区只有加入附件列表后才发送给模型。自动附加当前文件引用可选，默认关闭；实时 IDE 状态仍可用于本地命令和自动补全。
- **支持多根工作区**。
- **自动连接状态**：显示 `VS Code: connected` / `Cursor: connected` / `Trae: connected`，IDE 关闭后自动回到 `not connected`。
- 通过 `/ide-ping` **心跳**精确检测断开。
- 从 IDE 发送文件和代码选区，在输入框上方显示为**待发送附件**，支持悬停预览和单独移除；终端选区仍直接粘贴到输入框。
- 用已打开的 IDE 文件**增强 `@` 自动补全**。
- 通过 `/ide init`**一键安装配套编辑器扩展**。
- **Slash 命令**：
  - `/ide init` — 安装 VS Code / Cursor / Trae 配套扩展
  - `/ide-state`
  - `/ide-auto-file [on|off]` — 开启或关闭自动附加当前文件引用；不带参数查看状态
  - `/ide-bridge-port`
  - `/ide-insert-active-file`
  - `/ide-insert-selection`
  - `/ide-open-files`
  - `/ide-clear-selection`
  - `/ide-preview [编号]` — 预览附件
  - `/ide-remove-attachment [编号]` — 移除一个附件
  - `/ide-clear-attachments` — 清空待发送附件
- **快捷键**：
  - `Ctrl+Shift+A` / `Cmd+Shift+A`：附加当前文件
  - `Ctrl+Shift+S` / `Cmd+Shift+S`：附加当前选区

## 自动附加当前文件设置

自动 IDE 上下文**默认关闭**。附件列表为空时，不发送任何 IDE 上下文，重载后也是如此。页脚仅显示连接状态，不显示文件名或选区行号。

- `/ide-auto-file on`：IDE 连接时，每条用户消息自动包含当前文件路径引用。
- `/ide-auto-file off`：仅发送显式附件（默认）。
- `/ide-auto-file`：查看当前开关状态；`/ide-state` 也会显示此设置。

设置全局保存在 `~/.pi/agent/ide-bridge-settings.json`（或 `$PI_AGENT_DIR/ide-bridge-settings.json`），重载和重启后保持：

```json
{
  "autoIncludeActiveFile": false
}
```

命令修改立即对当前 Pi 实例生效；其他已运行实例需重载。手动修改 JSON 后执行 `/reload`。文件缺失或内容无效时，默认关闭。

开启后也只自动发送当前文件路径，不发送文件内容、工作区根目录、其他已打开文件或实时选区。选区始终需要显式添加附件。同一路径已有完整文件附件时，不再重复发送自动引用。移除或清空附件不会关闭此开关；请使用 `/ide-auto-file off`。

## 安装

```bash
pi install npm:pi-ide-bridge
```

或者用 git 安装：

```bash
pi install git:github.com/Wuhu-dsm/pi-ide-bridge
```

然后重载 Pi：

```text
/reload
```

### 安装配套编辑器扩展

Pi 扩展加载后，运行：

```text
/ide init
```

Pi 会自动检测 PATH 上的 VS Code / Cursor / Trae 命令行工具，从 GitHub 下载最新配套 `.vsix` 并完成安装。如果检测不到编辑器 CLI，请按下面的手动方式安装。

## 更新

```bash
pi update npm:pi-ide-bridge
/reload
```

## 卸载

```bash
pi remove npm:pi-ide-bridge
/reload
```

## 配套编辑器扩展

VS Code / Cursor / Trae 的配套扩展可以在 GitHub releases 下载 `.vsix`：

- 下载：https://github.com/Wuhu-dsm/pi-ide-bridge/releases/latest
- 用编辑器 CLI 安装：

```bash
# VS Code
code --install-extension pi-ide-bridge-vscode-0.4.0.vsix

# Cursor
cursor --install-extension pi-ide-bridge-vscode-0.4.0.vsix

# Trae
trae --install-extension pi-ide-bridge-vscode-0.4.0.vsix
```

或者在扩展视图中点击 `...` → **Install from VSIX**。

## 许可证

MIT
