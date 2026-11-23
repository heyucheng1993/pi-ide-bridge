# Pi IDE Bridge

Pi 扩展，用于把 IDE（VS Code、Cursor、Trae）和 Pi 编程助手连接起来。

[English](README.md)

## 此分支：附件预览

此分支将文件和代码选区显示为输入框上方的附件标签（例如 `[example.c ×]`、`[example.c 10:25 ×]`），不再直接粘贴到输入框。悬停可预览，点击红色 `×` 可单独移除；终端选区仍直接粘贴。

- `/ide-preview [编号]`：预览附件。
- `/ide-remove-attachment [编号]`：移除一个附件。
- `/ide-clear-attachments`：清空待发送附件。
- 附件随下一条用户消息发送，之后标签清空。重载或切换会话前请先发送或清除附件。
- 鼠标操作需要 Pi 全屏模式和终端鼠标支持；普通模式可使用上述命令。
- 需要 Pi / pi-tui 1.5.2 或更新版本。配套扩展源码包含准确的选区文件名和行号。

安装此分支：`pi install git:github.com/heyucheng1993/pi-ide-bridge@feat/attachment-previews`。请先停用其他重复加载的 bridge 扩展。构建配套 VSIX 和运行测试的方法见 [English README](README.md#development)。下方 npm 安装说明和 `/ide init` 仍指向上游已发布版本。

## 上游主要功能

- **实时 IDE 上下文**：当前文件、工作区根目录、已打开文件、当前选区。
- **支持多根工作区**。
- **自动连接状态**：显示 `VS Code: connected` / `Cursor: connected` / `Trae: connected`，IDE 关闭后自动回到 `not connected`。
- 通过 `/ide-ping` **心跳**精确检测断开。
- 从 IDE **插入文件/终端选区**到 Pi 的输入框。
- 用已打开的 IDE 文件**增强 `@` 自动补全**。
- 通过 `/ide init`**一键安装配套编辑器扩展**。
- **Slash 命令**：
  - `/ide init` — 安装 VS Code / Cursor / Trae 配套扩展
  - `/ide-state`
  - `/ide-bridge-port`
  - `/ide-insert-active-file`
  - `/ide-insert-selection`
  - `/ide-open-files`
  - `/ide-clear-selection`
- **快捷键**：
  - `Ctrl+Shift+A` / `Cmd+Shift+A`：插入当前文件
  - `Ctrl+Shift+S` / `Cmd+Shift+S`：插入当前选区

## 安装

```bash
pi install npm:pi-ide-bridge
```

或者用 git 安装：

```bash
pi install git:github.com/Wuhu-dsm/pi-ide-bridge@v0.4.0
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
