# Pi IDE Bridge

Pi extension that bridges your IDE (VS Code, Cursor, Trae) with the Pi coding agent.

## Features

- **Live IDE context**: active file, workspace roots, open files, and current selection.
- **Multi-root workspace support**.
- **Automatic connection state**: shows `VS Code: connected` / `Cursor: connected` / `Trae: connected` and falls back to `not connected` when the IDE closes.
- **Heartbeats** via `/ide-ping` for accurate disconnect detection.
- **Pending attachments**: files and selections appear as compact labels above the prompt, not pasted prompt text.
- **Content previews**: hover a label to see a bordered, opaque panel with dark/light colors, line numbers, and scrolling.
- **Individual removal**: click the red `×` beside an attachment to remove it; keyboard commands are also available.
- **Terminal inserts** still paste into Pi's input editor.
- **Enhanced `@` autocompletion** with open IDE files.
- **One-click companion install** via `/ide init`.
- **Slash commands**:
  - `/ide init` — install the VS Code / Cursor / Trae companion extension
  - `/ide-state`
  - `/ide-bridge-port`
  - `/ide-insert-active-file`
  - `/ide-insert-selection`
  - `/ide-open-files`
  - `/ide-clear-selection`
  - `/ide-preview [number]` — preview one pending attachment (picker when omitted)
  - `/ide-remove-attachment [number]` — remove one pending attachment (picker when omitted)
  - `/ide-clear-attachments` — clear all pending attachments
- **Keyboard shortcuts**:
  - `Ctrl+Shift+A` / `Cmd+Shift+A`: attach active file
  - `Ctrl+Shift+S` / `Cmd+Shift+S`: attach current selection

## Attachment workflow

Requires Pi and `@earendil-works/pi-tui` 1.5.2 or newer.

```text
Attached: [example.c ×] [example.c 10:25 ×]
```

Send a file or selection from the IDE, type your request normally, then submit it. Pending attachments are included as hidden session context with the next user-started run and cleared from the attachment bar. Files are references the model can read; selections preserve the exact text sent from the IDE. Multiple attachments accumulate, with identical items deduplicated.

- Hover a name for 250 ms to preview it. File previews read the current disk contents; selection previews show the saved text.
- The wheel scrolls inside a hover preview; moving away or typing closes it. `/ide-preview` provides keyboard access with arrow/Page Up/Page Down scrolling and Escape to close.
- Click `×` to remove only that pending item. Removal does not delete files or undo previously sent context. Original live IDE workspace/active-file context remains enabled.
- Mouse controls require fullscreen mode and terminal mouse reporting. In regular mode or multiplexers without hover support, use the slash commands. Attachment numbers are 1-based.
- Previews are bounded to 200 lines / 64 KiB, reject binary files, and never modify attachment contents. Pending attachments are in memory: send or clear them before reloading, changing sessions, or exiting.

### Install this fork

```bash
pi install git:github.com/heyucheng1993/pi-ide-bridge@feat/attachment-previews
```

Disable other copies of the bridge before loading this one, including an auto-discovered local customization. Otherwise multiple bridge listeners may receive the same IDE action.

The companion source in this fork includes selection filenames and inclusive line ranges in insertion requests, avoiding races with debounced IDE state. Older companions remain compatible, but labels fall back to cached IDE state. Build this fork's companion for reliable selection metadata; `/ide init` still downloads the upstream released companion.

## Install (upstream package)

```bash
pi install npm:pi-ide-bridge
```

Or install from git:

```bash
pi install git:github.com/Wuhu-dsm/pi-ide-bridge@v0.4.0
```

Then reload Pi:

```text
/reload
```

### Install the companion IDE extension

After the Pi extension is loaded, run:

```text
/ide init
```

Pi will detect any VS Code / Cursor / Trae CLI on your PATH, download the latest companion `.vsix` from GitHub, and install it automatically. If the editor CLI is not on PATH, install it manually (see below).

## Update

```bash
pi update npm:pi-ide-bridge
/reload
```

## Uninstall

```bash
pi remove npm:pi-ide-bridge
/reload
```

## Companion IDE Extension

The companion extension for VS Code / Cursor / Trae is available as a `.vsix` from the GitHub releases:

- Download: https://github.com/Wuhu-dsm/pi-ide-bridge/releases/latest
- Install with your editor's CLI:

```bash
# VS Code
code --install-extension pi-ide-bridge-vscode-0.4.0.vsix

# Cursor
cursor --install-extension pi-ide-bridge-vscode-0.4.0.vsix

# Trae
trae --install-extension pi-ide-bridge-vscode-0.4.0.vsix
```

Or open the Extensions view, click `...` → **Install from VSIX**.

## Development

```bash
npm ci
npm test
npm run typecheck

cd vscode-extension
npm ci
npm run compile
npx vsce package --out pi-ide-bridge-vscode-local.vsix
```

Install the generated VSIX with your editor's **Install from VSIX** command, then reload the editor. The attachment tests use a mock Pi UI and a real localhost HTTP server in a temporary state directory; they cover context delivery, previews, layouts, click/command removal, and cleanup. Actual terminal mouse interaction should also be checked manually.

This fork's attachment workflow is based on [Wuhu-dsm/pi-ide-bridge](https://github.com/Wuhu-dsm/pi-ide-bridge) 0.4.4. Upstream installation instructions above refer to the unmodified released package.

## License

MIT
