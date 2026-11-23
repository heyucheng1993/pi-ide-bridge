import * as fs from "node:fs/promises";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, parseColor, truncateToWidth, visibleWidth, type Component, type OverlayHandle, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";

export interface IDEAttachment {
	label: string;
	content: string;
	filePath?: string;
	selectionText?: string;
	startLine?: number;
}

const MAX_BYTES = 64 * 1024;
const MAX_LINES = 200;

// Explicit, opaque surfaces keep previews separate from arbitrary transcript
// colors. Both palettes provide high-contrast body text and a quieter gutter.
const PREVIEW_COLORS = {
	dark: {
		body: parseColor("#182638"), header: parseColor("#294563"),
		text: parseColor("#edf3fc"), muted: parseColor("#b1c6df"), border: parseColor("#81b5f0"),
	},
	light: {
		body: parseColor("#edf4fc"), header: parseColor("#cbdff5"),
		text: parseColor("#172b45"), muted: parseColor("#465e7a"), border: parseColor("#34679a"),
	},
};

// Treat code and filenames as plain text, never terminal escape sequences.
export function plainText(text: string): string {
	return text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "�");
}

export async function readPreview(item: IDEAttachment): Promise<string[]> {
	let text = item.selectionText;
	let truncated = false;
	if (text === undefined) {
		if (!item.filePath) return ["No preview available."];
		let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
		try {
			handle = await fs.open(item.filePath, "r");
			const stat = await handle.stat();
			if (!stat.isFile()) return ["Preview unavailable: not a regular file."];
			const buffer = Buffer.alloc(MAX_BYTES + 1);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			if (buffer.subarray(0, bytesRead).includes(0)) return ["Binary file: text preview unavailable."];
			text = buffer.subarray(0, Math.min(bytesRead, MAX_BYTES)).toString("utf8");
			truncated = bytesRead > MAX_BYTES;
		} catch (error) {
			return plainText(`Cannot read file: ${error instanceof Error ? error.message : String(error)}`).split("\n");
		} finally {
			await handle?.close();
		}
	}
	if (text.length > MAX_BYTES) {
		text = text.slice(0, MAX_BYTES);
		truncated = true;
	}
	const lines = plainText(text).split("\n");
	truncated ||= lines.length > MAX_LINES;
	const start = item.selectionText === undefined ? 1 : (item.startLine ?? 0) + 1;
	const result = lines.slice(0, MAX_LINES).map((line, index) => `${String(start + index).padStart(4)} │ ${line.replace(/\t/g, "    ")}`);
	if (truncated) result.push("… Preview truncated (limit: 200 lines / 64 KiB). Attachment is unchanged.");
	return result;
}

export class PreviewPanel implements Component {
	lines = ["Loading…"];
	offset = 0;
	private pageSize = 12;
	constructor(private tui: TUI, private theme: Theme, private item: IDEAttachment, private done?: () => void) {}
	async load(): Promise<void> {
		this.lines = await readPreview(this.item);
		this.tui.requestRender();
	}
	render(width: number): string[] {
		// Six chrome rows (borders, header, separators, footer), plus room
		// around the panel so small terminals do not crop its lower edge.
		this.pageSize = Math.max(1, Math.min(12, this.tui.terminal.rows - 8));
		this.offset = Math.max(0, Math.min(this.offset, this.lines.length - this.pageSize));
		const colors = PREVIEW_COLORS[this.theme.appearance === "light" ? "light" : "dark"];
		const inner = Math.max(0, width - 2);
		const style = (text: string, fg = colors.text, bg = colors.body, bold = false) =>
			this.theme.style(text, { fg, bg, bold });
		const edge = (text: string) => style(text, colors.border);
		const rule = (left: string, right: string) => edge(truncateToWidth(`${left}${"─".repeat(inner)}${right}`, width));
		const row = (text: string, header = false, gutter = false, footer = false) => {
			const bg = header || footer ? colors.header : colors.body;
			const fg = footer ? colors.muted : colors.text;
			if (width < 4) {
				return style(truncateToWidth(text, width, "…", true), fg, bg, header);
			}
			const padded = truncateToWidth(` ${text}`, Math.max(0, inner - 1), "…", true) + (inner > 0 ? " " : "");
			const match = gutter ? /^(\s*\d+ │ )(.*)$/.exec(padded) : null;
			const content = match
				? style(match[1], colors.muted, bg) + style(match[2], colors.text, bg)
				: style(padded, fg, bg, header);
			return truncateToWidth(edge("│") + content + edge("│"), width);
		};
		const label = plainText(this.item.label).replace(/\n/g, " ");
		const title = `${this.item.selectionText === undefined ? "FILE" : "SELECTION"} PREVIEW · ${label}`;
		const end = Math.min(this.lines.length, this.offset + this.pageSize);
		const position = `${this.offset + 1}–${end}/${this.lines.length}`;
		const help = this.done ? "↑↓/PgUp/PgDn scroll · Esc close" : "Wheel scroll · move away to close";
		return [
			rule("╭", "╮"),
			row(title, true),
			rule("├", "┤"),
			...this.lines.slice(this.offset, end).map((line) => row(line, false, true)),
			rule("├", "┤"),
			row(`${position} · ${help}`, false, false, true),
			rule("╰", "╯"),
		];
	}
	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "return")) this.done?.();
		else if (matchesKey(data, "up")) this.scroll(-1);
		else if (matchesKey(data, "down")) this.scroll(1);
		else if (matchesKey(data, "pageUp")) this.scroll(-this.pageSize);
		else if (matchesKey(data, "pageDown")) this.scroll(this.pageSize);
	}
	handleMouse(event: TuiMouseEvent) {
		if (event.type !== "wheel") return undefined;
		this.scroll(event.wheelDelta ?? 0);
		return { handled: true, render: true };
	}
	private scroll(delta: number): void {
		this.offset = Math.max(0, Math.min(Math.max(0, this.lines.length - this.pageSize), this.offset + delta));
		this.tui.requestRender();
	}
	invalidate(): void {}
}

interface LabelHit { item: IDEAttachment; x: number; y: number; width: number; removeX: number }
interface Rect { col: number; row: number; width: number; height: number }
const inside = (x: number, y: number, rect?: Rect) => rect !== undefined && x >= rect.col && x < rect.col + rect.width && y >= rect.row && y < rect.row + rect.height;

export class AttachmentWidget implements Component {
	private hits: LabelHit[] = [];
	private hovered?: IDEAttachment;
	private labelRect?: Rect;
	private timer?: ReturnType<typeof setTimeout>;
	private overlay?: OverlayHandle;
	private unsubscribe: () => void;
	private disposed = false;
	private generation = 0;
	constructor(private tui: TUI, private theme: Theme, private items: IDEAttachment[], private onRemove: (item: IDEAttachment) => void) {
		// No raw mouse tracking is enabled here. Fullscreen pi already owns it;
		// regular terminals retain native scrolling and text selection.
		this.unsubscribe = tui.addInputListener((data) => {
			if (!this.hovered) return undefined;
			const match = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/.exec(data);
			if (match) {
				const x = Number(match[2]) - 1, y = Number(match[3]) - 1;
				if (!inside(x, y, this.labelRect) && !inside(x, y, this.overlay?.getBounds())) this.closePreview();
			} else {
				this.closePreview();
			}
			return undefined;
		});
	}
	render(width: number): string[] {
		this.hits = [];
		if (width <= 0) return [];
		const lines: string[] = [];
		let line = truncateToWidth("Attached: ", width), x = visibleWidth(line);
		for (const item of this.items) {
			// Reserve space for the remove control, even when a long name is clipped.
			const name = truncateToWidth(plainText(item.label).replace(/\n/g, " "), Math.max(0, width - 4), "…");
			const prefix = width >= 5 ? `[${name} ` : "";
			const suffix = width >= 5 ? "]" : "";
			const size = visibleWidth(prefix) + 1 + visibleWidth(suffix);
			if (x > 0 && x + size > width) { lines.push(line); line = ""; x = 0; }
			const removeX = x + visibleWidth(prefix);
			this.hits.push({ item, x, y: lines.length, width: size, removeX });
			line += this.theme.fg("accent", prefix) + this.theme.fg("error", "×") + this.theme.fg("accent", suffix);
			x += size;
			if (x < width) { line += " "; x++; }
		}
		lines.push(line);
		lines.push(truncateToWidth(this.theme.fg("dim", "Hover to preview · × remove · /ide-remove-attachment · /ide-preview"), width));
		return lines;
	}
	handleMouse(event: TuiMouseEvent) {
		if (this.disposed) return undefined;
		if (event.type !== "move" && event.button !== "left") return undefined;
		const hit = this.hits.find((hit) => event.y === hit.y && event.x >= hit.x && event.x < hit.x + hit.width);
		if (!hit) { this.closePreview(); return undefined; }
		if (event.x === hit.removeX) {
			this.closePreview();
			if (event.type === "click") this.onRemove(hit.item);
			// Handle press so pi routes release/click to this component rather
			// than starting transcript selection. Only a completed click removes.
			return { handled: true, render: event.type === "click" };
		}
		if (event.type !== "move" && event.type !== "click") return { handled: true, render: false };
		this.labelRect = { col: event.screenX - event.x + hit.x, row: event.screenY, width: hit.width, height: 1 };
		if (this.hovered !== hit.item) {
			this.closePreview();
			this.hovered = hit.item;
			this.labelRect = { col: event.screenX - event.x + hit.x, row: event.screenY, width: hit.width, height: 1 };
			this.timer = setTimeout(() => { void this.openPreview(hit.item); }, 250);
		}
		return { handled: true, render: false };
	}
	private async openPreview(item: IDEAttachment): Promise<void> {
		this.timer = undefined;
		const generation = this.generation;
		const panel = new PreviewPanel(this.tui, this.theme, item);
		await panel.load();
		if (this.disposed || this.generation !== generation || this.hovered !== item || !this.labelRect) return;
		const width = Math.max(1, Math.min(100, this.tui.terminal.columns - 2));
		const height = panel.render(width).length;
		this.overlay = this.tui.showOverlay(panel, {
			nonCapturing: true, width,
			row: Math.max(0, this.labelRect.row - height),
			col: Math.max(0, Math.min(this.labelRect.col, this.tui.terminal.columns - width)),
		});
		this.tui.requestRender();
	}
	closePreview(): void {
		this.generation++;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.hovered = undefined;
		this.labelRect = undefined;
		this.overlay?.hide();
		this.overlay = undefined;
	}
	invalidate(): void { this.closePreview(); }
	dispose(): void {
		this.disposed = true;
		this.closePreview();
		this.unsubscribe();
	}
}
