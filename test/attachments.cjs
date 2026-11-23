const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createJiti } = require('jiti');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-attachments-test-'));
  process.env.PI_AGENT_DIR = dir;
  // Reserve an available local port instead of hard-coding a developer port.
  const probe = require('node:net').createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  process.env.PI_IDE_BRIDGE_PORT = String(probe.address().port);
  await new Promise(resolve => probe.close(resolve));
  const handlers = {}, commands = {}, widgets = new Map(), pasted = [];
  const listeners = new Set(), overlays = [];
  let selectedChoice = 0;
  const theme = { appearance: 'dark', fg(_color, text) { return text; }, style(text) { return text; } };
  const tui = {
    terminal: { rows: 35, columns: 120 }, mode: 'fullscreen', requestRender() {},
    addInputListener(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    showOverlay(panel, options) {
      const entry = { panel, options, hidden: false };
      overlays.push(entry);
      return { hide() { entry.hidden = true; }, getBounds() {
        return { row: options.row, col: options.col, width: options.width, height: panel.render(options.width).length };
      }};
    },
  };
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const ctx = { mode: 'tui', hasUI: true, ui: {
    setStatus() {}, notify() {}, addAutocompleteProvider() {},
    async select(_title, choices) { return selectedChoice === null ? undefined : choices[selectedChoice]; },
    setWidget(key, value) { widgets.set(key, typeof value === 'function' ? value(tui, theme) : value); },
    async custom(factory) {
      let closed = false;
      const panel = factory(tui, theme, {}, () => { closed = true; });
      await sleep(30);
      assert.ok(panel.render(80).length > 2);
      panel.handleInput('\x1b');
      assert.equal(closed, true);
    },
    pasteToEditor(text) { pasted.push(text); },
  }};
  const pi = {
    on(name, fn) { handlers[name] = fn; },
    registerCommand(name, command) { commands[name] = command; },
    registerShortcut() {},
  };
  const jiti = createJiti(__filename);
  const { default: extension } = await jiti.import(path.join(__dirname, '../extensions/ide-bridge.ts'));
  extension(pi);
  try {
    await handlers.session_start({}, ctx);
    const port = fs.readFileSync(path.join(dir, 'ide-bridge.port'), 'utf8');
    const post = async (data, route = '/editor-insert') => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: 'POST', body: JSON.stringify(data),
      });
      assert.equal(response.status, 200);
    };
    await post({ type: 'file', path: 'D:\\src\\hello.c' });
    await post({ type: 'text', text: '  int x = 1;\n', path: 'D:\\src\\hello.c', startLine: 0, endLine: 99 });
    assert.deepEqual(pasted, []);
    const widget = widgets.get('ide-attachments');
    assert.match(widget.render(100).join('\n'), /\[hello.c ×\] \[hello.c 1:100 ×\]/);
    const event = { type: 'move', x: 25, y: 0, screenX: 25, screenY: 28, width: 100, height: 2, button: 'none' };
    widget.handleMouse(event);
    await sleep(330);
    assert.equal(overlays.length, 1);
    assert.equal(overlays[0].options.nonCapturing, true);
    assert.match(overlays[0].panel.render(100).join('\n'), /1 │   int x = 1;/);
    // Moving away closes the tooltip without consuming terminal input.
    for (const listener of listeners) assert.equal(listener('\x1b[<35;120;1M'), undefined);
    assert.equal(overlays[0].hidden, true);
    // Wrapping and narrow widths preserve bounded render lines and hit testing.
    for (const width of [1, 8, 20, 40]) {
      const { visibleWidth } = await jiti.import('@earendil-works/pi-tui');
      assert.ok(widget.render(width).every(line => visibleWidth(line) <= width));
    }
    await commands['ide-preview'].handler('2', ctx);
    const { readPreview, plainText, PreviewPanel } = await jiti.import(path.join(__dirname, '../extensions/lib/attachment-preview.ts'));
    const { styleText, visibleWidth } = await jiti.import('@earendil-works/pi-tui');
    const { stripVTControlCharacters: stripAnsi } = require('node:util');
    // Every row, including padding and borders, has an explicit background.
    // Verify both palettes and a range of terminal widths and heights.
    for (const appearance of ['dark', 'light']) {
      const styledTheme = { ...theme, appearance, style(text, options) { return styleText(text, options, 'truecolor'); } };
      const panel = new PreviewPanel(tui, styledTheme, { label: '代码.c 2190:2199', selectionText: 'code' });
      panel.lines = Array.from({ length: 30 }, (_, i) => `${2190 + i} │ int result_${i} = 0;`);
      for (const height of [9, 15, 35]) {
        tui.terminal.rows = height;
        for (const width of [1, 2, 3, 8, 40, 100]) {
          const rows = panel.render(width);
          assert.ok(rows.every(line => visibleWidth(line) === width));
          assert.ok(rows.every(line => /\x1b\[48;2;/.test(line)), JSON.stringify({ width, rows }));
          assert.ok(rows.length <= height);
        }
      }
      const rows = panel.render(100);
      assert.match(stripAnsi(rows[0]), /^╭─+╮$/);
      assert.match(stripAnsi(rows[1]), /SELECTION PREVIEW · 代码.c 2190:2199/);
      assert.match(rows[1], /\x1b\[1m/); // bold header
      assert.match(stripAnsi(rows.at(-2)), /1–12\/30.*Wheel scroll/);
      assert.match(stripAnsi(rows.at(-1)), /^╰─+╯$/);
      const backgrounds = line => [...line.matchAll(/\x1b\[48;2;[^m]+m/g)].map(match => match[0]);
      assert.ok(backgrounds(rows[1]).some(bg => !backgrounds(rows[3]).includes(bg)));
      panel.handleMouse({ type: 'wheel', wheelDelta: 4 });
      assert.match(stripAnsi(panel.render(100).at(-2)), /5–16\/30/);
      const filePanel = new PreviewPanel(tui, styledTheme, { label: 'file.c', filePath: 'file.c' });
      assert.match(stripAnsi(filePanel.render(100)[1]), /FILE PREVIEW/);
    }
    const previewFile = path.join(dir, 'preview.c');
    fs.writeFileSync(previewFile, 'first line\nsecond line\n');
    assert.match((await readPreview({ filePath: previewFile })).join('\n'), /2 │ second line/);
    assert.match((await readPreview({ filePath: path.join(dir, 'missing.c') }))[0], /Cannot read file/);
    fs.writeFileSync(previewFile, Buffer.from([0, 1, 2]));
    assert.match((await readPreview({ filePath: previewFile }))[0], /Binary file/);
    fs.writeFileSync(previewFile, 'line\n'.repeat(100000));
    assert.match((await readPreview({ filePath: previewFile })).at(-1), /truncated/);
    assert.equal(plainText('\x1b[31mcode'), '�[31mcode');
    // A remove control identifies the exact attachment, even with duplicate basenames.
    await post({ type: 'file', path: 'D:\\other\\hello.c' });
    const removalWidget = widgets.get('ide-attachments');
    const removalRows = removalWidget.render(25);
    const controls = [];
    removalRows.forEach((line, y) => {
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '×' && !line.includes('Hover to preview')) controls.push({ x: visibleWidth(line.slice(0, i)), y });
      }
    });
    assert.equal(controls.length, 3);
    const removeEvent = { ...event, ...controls[2], button: 'left' };
    // Hover and a right click are harmless, and do not start a tooltip.
    const overlayCount = overlays.length;
    removalWidget.handleMouse({ ...removeEvent, type: 'move', button: 'none' });
    removalWidget.handleMouse({ ...removeEvent, type: 'click', button: 'right' });
    await sleep(300);
    assert.equal(overlays.length, overlayCount);
    assert.equal(widgets.get('ide-attachments'), removalWidget);
    assert.equal(removalWidget.handleMouse({ ...removeEvent, type: 'press' }).handled, true);
    removalWidget.handleMouse({ ...removeEvent, type: 'release' });
    assert.equal(widgets.get('ide-attachments'), removalWidget);
    removalWidget.handleMouse({ ...removeEvent, type: 'click' });
    const remaining = widgets.get('ide-attachments');
    assert.notEqual(remaining, removalWidget);
    assert.match(remaining.render(100).join('\n'), /\[hello.c ×\] \[hello.c 1:100 ×\]/);
    // A stale event from the disposed widget cannot remove a new neighbour.
    removalWidget.handleMouse({ ...removeEvent, type: 'click' });
    assert.equal(widgets.get('ide-attachments'), remaining);
    assert.equal(listeners.size, 1);
    assert.equal(await handlers.before_agent_start({ messageType: 'custom' }, ctx), undefined);
    assert.ok(widgets.get('ide-attachments'));
    const result = await handlers.before_agent_start({ messageType: 'user' }, ctx);
    assert.equal(result.message.display, false);
    assert.match(result.message.content, /Attached IDE file: D:\\src\\hello.c/);
    assert.ok(result.message.content.endsWith('  int x = 1;\n'));
    assert.doesNotMatch(result.message.content, /D:\\other\\hello.c/);
    assert.equal(widgets.get('ide-attachments'), undefined);
    assert.equal(listeners.size, 0);
    assert.equal(await handlers.before_agent_start({ messageType: 'user' }, ctx), undefined);
    await post({ type: 'file', path: 'D:\\src\\hello.c' });
    await post({ type: 'file', path: 'D:\\src\\second.c' });
    let beforeInvalid = widgets.get('ide-attachments');
    await commands['ide-remove-attachment'].handler('0', ctx);
    assert.equal(widgets.get('ide-attachments'), beforeInvalid);
    await commands['ide-remove-attachment'].handler('2', ctx);
    assert.doesNotMatch(widgets.get('ide-attachments').render(100).join('\n'), /second.c/);
    await post({ type: 'file', path: 'D:\\src\\third.c' });
    selectedChoice = null;
    beforeInvalid = widgets.get('ide-attachments');
    await commands['ide-remove-attachment'].handler('', ctx);
    assert.equal(widgets.get('ide-attachments'), beforeInvalid);
    selectedChoice = 1;
    await commands['ide-remove-attachment'].handler('', ctx);
    assert.doesNotMatch(widgets.get('ide-attachments').render(100).join('\n'), /third.c/);
    // Last attachment removal clears the entire widget and its listener.
    await commands['ide-remove-attachment'].handler('1', ctx);
    assert.equal(widgets.get('ide-attachments'), undefined);
    assert.equal(listeners.size, 0);
    await post({ type: 'file', path: 'D:\\src\\hello.c' });
    await commands['ide-clear-attachments'].handler('', ctx);
    assert.equal(await handlers.before_agent_start({ messageType: 'user' }, ctx), undefined);
    await post({ type: 'terminal', text: 'terminal text' });
    assert.deepEqual(pasted, ['terminal text']);
    // Removing a selection also clears the matching cached automatic selection.
    await post({ editor: 'vscode', activeFile: 'D:\\src\\selection.c', workspaceRoot: 'D:\\src', openFiles: [],
      selection: { text: 'removed_selection_text', startLine: 10, endLine: 10 } }, '/ide-state');
    await post({ type: 'text', text: 'removed_selection_text', path: 'D:\\src\\selection.c', startLine: 10, endLine: 10 });
    await post({ type: 'file', path: 'D:\\src\\retained.c' });
    const pendingWidget = widgets.get('ide-attachments');
    pendingWidget.render(100);
    pendingWidget.handleMouse({ ...event, x: 12, screenX: 12 });
    const beforeRemove = overlays.length;
    await commands['ide-remove-attachment'].handler('1', ctx);
    await sleep(300);
    assert.equal(overlays.length, beforeRemove); // no delayed tooltip for a deleted item
    const afterRemoval = await handlers.before_agent_start({ messageType: 'user' }, ctx);
    assert.doesNotMatch(afterRemoval.message.content, /removed_selection_text|Attached IDE selection/);
    assert.match(afterRemoval.message.content, /retained.c/);
    assert.equal(listeners.size, 0);
    console.log('PASS: single-remove clicks/commands/picker, wrapped hit areas, duplicate filenames, safe press/right-click, stale events, cancelled hover, cached selection cleanup, previews, layouts, one-shot context, clear, terminal paste');
  } finally {
    await handlers.session_shutdown({}, ctx);
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
