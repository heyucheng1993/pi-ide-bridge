/**
 * IDE Bridge Extension for pi-coding-agent.
 *
 * Provides IDE context awareness for VS Code / Cursor / Trae:
 * - Receives active file, open files, workspace roots, and current selection.
 * - Displays the active file/selection in the footer status bar.
 * - Injects the active file and selection into the LLM context on each prompt,
 *   then clears the selection so stale code is not carried into follow-ups.
 * - Enhances `@` autocompletion with IDE open files.
 * - Queues files and selections as previewable, removable prompt attachments.
 * - Accepts terminal insertions from the companion IDE extension.
 * - Tracks IDE heartbeats and reverts to "not connected" when the IDE goes away.
 * - Provides `/ide init` to download and install the companion IDE extension.
 *
 * Each new Pi terminal binds to the first free port in the configured range so
 * multiple Pi instances can run side by side without EADDRINUSE errors.
 *
 * Requires the companion VS Code / Cursor / Trae extension.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ExecResult } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions, KeyId } from "@earendil-works/pi-tui";
import { AttachmentWidget, PreviewPanel, type IDEAttachment } from "./lib/attachment-preview.ts";

interface IDESelection {
	text: string;
	startLine: number;
	endLine: number;
}

type IDEEditor = "vscode" | "cursor" | "trae";

interface IDEStateUpdate {
	editor: string;
	activeFile: string | null;
	workspaceRoot: string | null;
	workspaceRoots?: string[] | null;
	openFiles: string[];
	selection: IDESelection | null;
}

interface IDEFileInsert {
	type: "file";
	path: string;
}

interface IDETextInsert {
	type: "text";
	text: string;
	path?: string;
	startLine?: number;
	endLine?: number;
}

interface IDETerminalInsert {
	type: "terminal";
	text: string;
}

type IDEInsertRequest = IDEFileInsert | IDETextInsert | IDETerminalInsert;

interface IDEState {
	connected: boolean;
	editor: IDEEditor | null;
	activeFile: string | null;
	workspaceRoots: string[];
	openFiles: string[];
	selection: IDESelection | null;
}

const DEFAULT_PORT = 17325;
const MAX_PORT_ATTEMPTS = 10;
const MAX_SELECTION_CHARS = 4000;
const MAX_SELECTION_LINES = 100;
const MAX_OPEN_FILES_IN_AUTOCOMPLETE = 20;
const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

const HEARTBEAT_INTERVAL_MS = 2_000;
const HEARTBEAT_TIMEOUT_MS = 5_000;

const STATE_FILE_NAME = "ide-bridge-state.json";
const STATE_MAX_AGE_MS = 60_000;

const EDITOR_LABELS: Record<IDEEditor, string> = {
	vscode: "VS Code",
	cursor: "Cursor",
	trae: "Trae",
};

function getAgentDir(): string {
	return process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

function getPortFilePath(): string {
	return path.join(getAgentDir(), "ide-bridge.port");
}

function getStateFilePath(): string {
	return path.join(getAgentDir(), STATE_FILE_NAME);
}

interface PersistedIDEState {
	persistedAt: number;
	state: IDEState;
}

function persistState(currentState: IDEState): void {
	try {
		fs.mkdirSync(getAgentDir(), { recursive: true });
		const payload: PersistedIDEState = {
			persistedAt: Date.now(),
			state: currentState,
		};
		fs.writeFileSync(getStateFilePath(), JSON.stringify(payload), "utf8");
	} catch {
		// Best-effort persistence.
	}
}

function loadPersistedState(): { state: IDEState; persistedAt: number } | null {
	try {
		const raw = fs.readFileSync(getStateFilePath(), "utf8");
		const parsed = JSON.parse(raw) as PersistedIDEState;
		if (typeof parsed.persistedAt !== "number") return null;
		if (Date.now() - parsed.persistedAt > STATE_MAX_AGE_MS) return null;

		const s = parsed.state;
		if (
			typeof s !== "object" ||
			s === null ||
			typeof s.connected !== "boolean" ||
			!Array.isArray(s.workspaceRoots) ||
			!Array.isArray(s.openFiles)
		) {
			return null;
		}

		return {
			state: {
				connected: s.connected,
				editor: s.editor,
				activeFile: s.activeFile,
				workspaceRoots: s.workspaceRoots,
				openFiles: s.openFiles,
				selection: s.selection,
			},
			persistedAt: parsed.persistedAt,
		};
	} catch {
		return null;
	}
}

function normalizeEditor(editor: string | null | undefined): IDEEditor | null {
	if (!editor) return null;
	const normalized = editor.toLowerCase().trim().replace(/\s+/g, "");
	switch (normalized) {
		case "vscode":
		case "visualstudiocode":
		case "code":
			return "vscode";
		case "cursor":
			return "cursor";
		case "trae":
		case "traecn":
			return "trae";
		default:
			return null;
	}
}

function getEditorLabel(editor: IDEEditor | null): string {
	return editor ? (EDITOR_LABELS[editor] ?? "IDE") : "IDE";
}

function getRelativeFileDisplay(activeFile: string, workspaceRoots: string[]): string {
	const baseName = path.posix.basename(activeFile.replace(/\\/g, "/"));
	if (workspaceRoots.length === 0) return baseName;

	let best: string | null = null;
	let bestScore = Number.POSITIVE_INFINITY;

	for (const root of workspaceRoots) {
		const rel = path.win32.relative(path.win32.normalize(root), path.win32.normalize(activeFile));
		if (!rel || rel.startsWith("..") || path.win32.isAbsolute(rel)) continue;
		const normalized = rel.replace(/\\/g, "/");
		// Prefer shorter, shallower relative paths.
		const score = normalized.length + normalized.split("/").length;
		if (score < bestScore) {
			bestScore = score;
			best = normalized;
		}
	}

	return best ?? baseName;
}

function getBasePort(): number {
	const env = process.env.PI_IDE_BRIDGE_PORT;
	if (!env) return DEFAULT_PORT;
	const parsed = Number.parseInt(env, 10);
	return Number.isNaN(parsed) ? DEFAULT_PORT : parsed;
}

function truncateSelection(selection: IDESelection): IDESelection {
	let truncated = selection.text;

	const lines = truncated.split("\n");
	if (lines.length > MAX_SELECTION_LINES) {
		truncated = `${lines.slice(0, MAX_SELECTION_LINES).join("\n")}\n... (selection truncated)`;
	}

	if (truncated.length > MAX_SELECTION_CHARS) {
		truncated = `${truncated.slice(0, MAX_SELECTION_CHARS)}\n... (selection truncated)`;
	}

	const endLine = selection.startLine + truncated.split("\n").length - 1;

	return {
		text: truncated,
		startLine: selection.startLine,
		endLine,
	};
}

function formatStatus(state: IDEState, boundPort: number | null): string | undefined {
	if (!state.connected) {
		return boundPort !== null ? `IDE: not connected (port ${boundPort})` : "IDE: not connected";
	}

	const editorLabel = getEditorLabel(state.editor);
	const fileName = state.activeFile
		? getRelativeFileDisplay(state.activeFile, state.workspaceRoots)
		: "connected";
	const selectionInfo = state.selection ? ` [${state.selection.startLine + 1}-${state.selection.endLine + 1}]` : "";

	return `${editorLabel}: ${fileName}${selectionInfo}`;
}

function buildContextMessage(state: IDEState): string {
	const parts: string[] = [];

	const workspaceRoot = state.workspaceRoots[0];
	if (workspaceRoot) {
		parts.push(`IDE workspace root: ${workspaceRoot}`);
	}

	if (state.activeFile) {
		parts.push(`Active IDE file: ${state.activeFile}`);
	}

	if (state.selection?.text) {
		const sel = state.selection;
		const langHint = state.activeFile ? (state.activeFile.split(".").pop() ?? "") : "";
		const fenceOpen = langHint ? `\`\`\`${langHint}` : "\`\`\`";
		parts.push(
			`Selected code in IDE (lines ${sel.startLine + 1}-${sel.endLine + 1}):\n${fenceOpen}\n${sel.text}\n\`\`\``,
		);
	}

	return parts.join("\n\n");
}

function extractAtToken(textBeforeCursor: string): string | undefined {
	const match = textBeforeCursor.match(/(?:^|[\t ])@([^\s]*)$/);
	return match?.[1];
}

function createIDEAutocompleteProvider(current: AutocompleteProvider, getState: () => IDEState): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const currentLine = lines[cursorLine] ?? "";
			const textBeforeCursor = currentLine.slice(0, cursorCol);
			const token = extractAtToken(textBeforeCursor);
			if (token === undefined) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const state = getState();
			if (!state.connected || state.openFiles.length === 0) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const query = token.toLowerCase();
			const uniqueFiles = Array.from(
				new Set([state.activeFile, ...state.openFiles].filter((file): file is string => file !== null)),
			);

			const matches: AutocompleteItem[] = [];
			for (const file of uniqueFiles.slice(0, MAX_OPEN_FILES_IN_AUTOCOMPLETE)) {
				if (query && !file.toLowerCase().includes(query)) continue;
				matches.push({
					value: `@${file}`,
					label: getRelativeFileDisplay(file, state.workspaceRoots),
					description: file,
				});
			}

			if (matches.length === 0) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			return {
				items: matches,
				prefix: `@${token}`,
			};
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

function escapeMarkdownLinkText(text: string): string {
	return text.replace(/([\\\`*_{}[\]()#+\-.!|])/g, "\\$1");
}

function encodeFileUrl(filePath: string): string {
	return encodeURI(filePath.replace(/\\/g, "/")).replace(/[()]/g, (c) =>
		`%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

function fileToMarkdownLink(filePath: string): string {
	const name = path.posix.basename(filePath.replace(/\\/g, "/")) || filePath;
	const url = `file://${encodeFileUrl(filePath)}`;
	return `[${escapeMarkdownLinkText(name)}](${url})`;
}

function readJsonBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = "";
		let length = 0;
		req.setEncoding("utf8");
		req.on("data", (chunk: string) => {
			length += Buffer.byteLength(chunk, "utf8");
			if (length > MAX_REQUEST_BODY_BYTES) {
				req.destroy();
				reject(new Error("Request body too large"));
				return;
			}
			body += chunk;
		});
		req.on("end", () => resolve(body));
		req.on("error", reject);
	});
}

function tryListen(server: Server, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
}

async function startServer(server: Server, basePort: number): Promise<number> {
	for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset++) {
		const port = basePort + offset;
		try {
			await tryListen(server, port);
			return port;
		} catch (err: unknown) {
			const errnoError = err as NodeJS.ErrnoException;
			if (errnoError.code !== "EADDRINUSE" || offset === MAX_PORT_ATTEMPTS - 1) {
				throw err;
			}
		}
	}
	throw new Error(`Could not bind IDE bridge server after ${MAX_PORT_ATTEMPTS} attempts`);
}

function validateIDEStateUpdate(update: unknown): update is IDEStateUpdate {
	if (typeof update !== "object" || update === null) return false;
	const u = update as Record<string, unknown>;
	if (typeof u.editor !== "string") return false;
	if (u.activeFile !== null && typeof u.activeFile !== "string") return false;
	if (u.workspaceRoot !== null && typeof u.workspaceRoot !== "string") return false;
	if (u.workspaceRoots !== undefined && u.workspaceRoots !== null) {
		if (!Array.isArray(u.workspaceRoots) || !u.workspaceRoots.every((r) => typeof r === "string")) return false;
	}
	if (!Array.isArray(u.openFiles) || !u.openFiles.every((f) => typeof f === "string")) return false;
	if (u.selection !== null) {
		if (typeof u.selection !== "object") return false;
		const s = u.selection as Record<string, unknown>;
		if (typeof s.text !== "string") return false;
		if (typeof s.startLine !== "number") return false;
		if (typeof s.endLine !== "number") return false;
	}
	return true;
}

function validateIDEInsertRequest(request: unknown): request is IDEInsertRequest {
	if (typeof request !== "object" || request === null) return false;
	const r = request as Record<string, unknown>;
	if (r.type === "file") return typeof r.path === "string";
	if (r.type === "text") {
		return typeof r.text === "string"
			&& (r.path === undefined || typeof r.path === "string")
			&& (r.startLine === undefined || (Number.isInteger(r.startLine) && (r.startLine as number) >= 0))
			&& (r.endLine === undefined || (Number.isInteger(r.endLine) && (r.endLine as number) >= 0));
	}
	if (r.type === "terminal") return typeof r.text === "string";
	return false;
}

function isSameSelection(a: IDESelection | null, b: IDESelection | null): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return a.text === b.text && a.startLine === b.startLine && a.endLine === b.endLine;
}

function isSameStringArray(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	return a.every((value, index) => value === b[index]);
}

function isSameState(a: IDEState, b: IDEStateUpdate, normalizedEditor: IDEEditor | null): boolean {
	if (a.editor !== normalizedEditor) return false;
	if (a.activeFile !== b.activeFile) return false;
	const roots = b.workspaceRoots ?? (b.workspaceRoot ? [b.workspaceRoot] : []);
	if (!isSameStringArray(a.workspaceRoots, roots)) return false;
	if (!isSameStringArray(a.openFiles, b.openFiles)) return false;
	if (!isSameSelection(a.selection, b.selection)) return false;
	return true;
}

// ============================================================================
// One-click companion extension installer ("/ide init")
// ============================================================================

const GITHUB_OWNER = "Wuhu-dsm";
const GITHUB_REPO = "pi-ide-bridge";
const VSIX_ASSET_PREFIX = "pi-ide-bridge-vscode-";
const VSIX_ASSET_SUFFIX = ".vsix";
const INSTALL_TIMEOUT_MS = 60_000;

interface GitHubReleaseAsset {
	name: string;
	browser_download_url: string;
	content_type?: string;
}

interface GitHubRelease {
	tag_name: string;
	assets: GitHubReleaseAsset[];
}

interface EditorCandidate {
	name: string;
	cli: string;
}

interface DetectedEditor {
	name: string;
	cli: string;
	version: string;
}

const EDITOR_CANDIDATES: EditorCandidate[] = [
	{ name: "VS Code", cli: "code" },
	{ name: "VS Code Insiders", cli: "code-insiders" },
	{ name: "Cursor", cli: "cursor" },
	{ name: "Trae", cli: "trae" },
	{ name: "Trae CN", cli: "trae.cn" },
];

async function fetchLatestRelease(): Promise<{ version: string; assetUrl: string; assetName: string }> {
	const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"User-Agent": "pi-ide-bridge-extension",
	};
	const token = process.env.GITHUB_TOKEN;
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	const response = await fetch(url, { headers });
	if (!response.ok) {
		throw new Error(`GitHub API returned ${response.status} ${response.statusText}`);
	}

	const release = (await response.json()) as GitHubRelease;
	const asset = release.assets.find(
		(a) => a.name.startsWith(VSIX_ASSET_PREFIX) && a.name.endsWith(VSIX_ASSET_SUFFIX),
	);
	if (!asset) {
		throw new Error(`No .vsix asset found in release ${release.tag_name}`);
	}

	const version = release.tag_name.replace(/^v/, "");
	return { version, assetUrl: asset.browser_download_url, assetName: asset.name };
}

async function downloadVsix(assetUrl: string, assetName: string): Promise<string> {
	const response = await fetch(assetUrl);
	if (!response.ok) {
		throw new Error(`Download returned ${response.status} ${response.statusText}`);
	}

	const buffer = await response.arrayBuffer();
	const tempPath = path.join(os.tmpdir(), `pi-ide-bridge-${Date.now()}-${assetName}`);
	await fsp.writeFile(tempPath, new Uint8Array(buffer));
	return tempPath;
}

async function execEditorCli(
	pi: ExtensionAPI,
	cli: string,
	args: string[],
	options: { timeout: number },
): Promise<ExecResult> {
	// On Windows, editor CLIs ship as .cmd wrappers in a directory on PATH.
	// pi.exec uses Node's spawn with shell:false, which cannot resolve or
	// execute .cmd files directly. Run via cmd /c so PATH resolution works.
	if (process.platform === "win32") {
		return pi.exec("cmd", ["/c", cli, ...args], options);
	}
	return pi.exec(cli, args, options);
}

async function detectInstalledEditors(pi: ExtensionAPI): Promise<DetectedEditor[]> {
	const detected: DetectedEditor[] = [];
	for (const candidate of EDITOR_CANDIDATES) {
		const result = await execEditorCli(pi, candidate.cli, ["--version"], { timeout: 5_000 });
		if (result.code === 0) {
			const version = result.stdout.split(/\r?\n/)[0]?.trim() || "unknown";
			detected.push({ ...candidate, version });
		}
	}
	return detected;
}

async function installVsix(pi: ExtensionAPI, cli: string, vsixPath: string): Promise<ExecResult> {
	return execEditorCli(pi, cli, ["--install-extension", vsixPath, "--force"], { timeout: INSTALL_TIMEOUT_MS });
}

export default function (pi: ExtensionAPI): void {
	let state: IDEState = {
		connected: false,
		editor: null,
		activeFile: null,
		workspaceRoots: [],
		openFiles: [],
		selection: null,
	};

	let server: Server | null = null;
	let boundPort: number | null = null;
	let serverErrorNotified = false;
	let currentCtx: ExtensionContext | undefined;
	let lastActivityAt = 0;
	let heartbeatTimer: NodeJS.Timeout | undefined;
	let attachments: IDEAttachment[] = [];
	let attachmentWidget: AttachmentWidget | undefined;

	function updateAttachments(ctx: ExtensionContext): void {
		attachmentWidget?.dispose();
		attachmentWidget = undefined;
		ctx.ui.setWidget("ide-attachments", attachments.length ? (tui, theme) => {
			attachmentWidget?.dispose();
			attachmentWidget = new AttachmentWidget(tui, theme, attachments, (item) => removeAttachment(ctx, item));
			return attachmentWidget;
		} : undefined);
	}

	function removeAttachment(ctx: ExtensionContext, item: IDEAttachment): void {
		if (!attachments.includes(item)) return;
		attachments = attachments.filter((existing) => existing !== item);
		// Do not immediately resend the removed selection through cached IDE context.
		if (item.selectionText !== undefined && state.selection
			&& item.filePath === (state.activeFile ?? undefined)
			&& (item.startLine === state.selection.startLine || item.selectionText === state.selection.text)) {
			state.selection = null;
			updateStatus(ctx);
		}
		updateAttachments(ctx);
	}

	function attach(ctx: ExtensionContext, item: IDEAttachment): void {
		if (!attachments.some((existing) => existing.label === item.label && existing.content === item.content)) {
			attachments.push(item);
		}
		updateAttachments(ctx);
	}

	function updateStatus(ctx: ExtensionContext): void {
		const status = formatStatus(state, boundPort);
		if (status !== undefined) {
			ctx.ui.setStatus("ide-bridge", status);
		}
	}

	function resetState(): void {
		state = {
			connected: false,
			editor: null,
			activeFile: null,
			workspaceRoots: [],
			openFiles: [],
			selection: null,
		};
	}

	function markActivity(ctx?: ExtensionContext): void {
		lastActivityAt = Date.now();
		if (!state.connected) {
			state.connected = true;
			if (ctx) updateStatus(ctx);
		}
	}

	function writePortFile(): void {
		if (boundPort === null) return;
		try {
			fs.mkdirSync(getAgentDir(), { recursive: true });
			fs.writeFileSync(getPortFilePath(), String(boundPort), "utf8");
		} catch {
			// Best-effort; the companion extension can still scan the port range.
		}
	}

	function deletePortFile(): void {
		try {
			if (fs.existsSync(getPortFilePath())) {
				fs.unlinkSync(getPortFilePath());
			}
		} catch {
			// Ignore cleanup errors.
		}
	}

	function checkHeartbeat(): void {
		if (!state.connected) return;
		if (Date.now() - lastActivityAt > HEARTBEAT_TIMEOUT_MS) {
			state.connected = false;
			state.editor = null;
			state.activeFile = null;
			state.workspaceRoots = [];
			state.openFiles = [];
			state.selection = null;
			if (currentCtx) updateStatus(currentCtx);
		}
	}

	function insertIntoEditor(ctx: ExtensionContext | undefined, request: IDEInsertRequest): void {
		if (!ctx) return;
		if (ctx.mode !== "tui") return;

		if (request.type === "file") {
			const label = path.posix.basename(request.path.replace(/\\/g, "/"));
			attach(ctx, { label, filePath: request.path, content: `Attached IDE file: ${request.path}\nRead this file when needed for the user's request.` });
		} else if (request.type === "text") {
			if (!request.text.trim()) return;
			const file = request.path ?? state.activeFile;
			const start = request.startLine ?? state.selection?.startLine;
			const end = request.endLine ?? state.selection?.endLine;
			const name = file ? path.posix.basename(file.replace(/\\/g, "/")) : "selection";
			const range = start !== undefined && end !== undefined ? ` ${start + 1}:${end + 1}` : "";
			attach(ctx, {
				label: `${name}${range}`,
				filePath: file ?? undefined,
				selectionText: request.text,
				startLine: start,
				content: `Attached IDE selection: ${file ?? "unknown file"}${range}\n\n${request.text}`,
			});
		} else {
			const text = request.text.trim();
			if (text) ctx.ui.pasteToEditor(text);
			updateStatus(ctx);
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		currentCtx = ctx;

		const persisted = loadPersistedState();
		if (persisted) {
			state = persisted.state;
			lastActivityAt = persisted.persistedAt;
			updateStatus(ctx);
		}

		if (server !== null) {
			updateStatus(ctx);
			return;
		}

		const basePort = getBasePort();

		server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
			if (req.method !== "POST") {
				res.writeHead(404);
				res.end("not found");
				return;
			}

			let body: string;
			try {
				body = await readJsonBody(req);
			} catch {
				res.writeHead(413);
				res.end("payload too large");
				return;
			}
			const ctxRef = currentCtx ?? ctx;

			if (req.url === "/ide-ping") {
				const wasConnected = state.connected;
				markActivity(ctxRef);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ needState: !wasConnected }));
				return;
			}

			if (req.url === "/ide-state") {
				let update: unknown;
				try {
					update = JSON.parse(body);
				} catch {
					res.writeHead(400);
					res.end("bad request");
					return;
				}
				if (!validateIDEStateUpdate(update)) {
					res.writeHead(400);
					res.end("invalid state");
					return;
				}

				const normalizedEditor = normalizeEditor(update.editor);
				const roots = update.workspaceRoots ?? (update.workspaceRoot ? [update.workspaceRoot] : []);

				// Skip redundant updates to avoid spamming the footer and re-rendering.
				if (!isSameState(state, update, normalizedEditor)) {
					state = {
						connected: true,
						editor: normalizedEditor,
						activeFile: update.activeFile,
						workspaceRoots: roots,
						openFiles: update.openFiles,
						selection: update.selection ? truncateSelection(update.selection) : null,
					};
					updateStatus(ctxRef);
					persistState(state);
				}
				markActivity(ctxRef);
				res.writeHead(200);
				res.end("ok");
				return;
			}

			if (req.url === "/editor-insert") {
				let request: unknown;
				try {
					request = JSON.parse(body);
				} catch {
					res.writeHead(400);
					res.end("bad request");
					return;
				}
				if (!validateIDEInsertRequest(request)) {
					res.writeHead(400);
					res.end("invalid insert request");
					return;
				}

				markActivity(ctxRef);
				insertIntoEditor(ctxRef, request);
				res.writeHead(200);
				res.end("ok");
				return;
			}

			res.writeHead(404);
			res.end("not found");
		});

		server.on("error", (err: NodeJS.ErrnoException) => {
			if (!serverErrorNotified) {
				serverErrorNotified = true;
				ctx.ui.notify(`IDE bridge server error: ${err.message}`, "error");
			}
		});

		try {
			boundPort = await startServer(server, basePort);
			writePortFile();
			ctx.ui.notify(`IDE bridge listening on 127.0.0.1:${boundPort}`, "info");
			ctx.ui.addAutocompleteProvider((current) => createIDEAutocompleteProvider(current, () => state));
			updateStatus(ctx);
			heartbeatTimer = setInterval(checkHeartbeat, HEARTBEAT_INTERVAL_MS);
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(`IDE bridge failed to start: ${message}`, "error");
			if (server !== null) {
				server.close();
				server = null;
			}
		}
	});

	pi.on("session_shutdown", async () => {
		attachmentWidget?.dispose();
		attachmentWidget = undefined;
		persistState(state);
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = undefined;
		}
		if (server !== null) {
			server.close();
			server = null;
		}
		deletePortFile();
		boundPort = null;
		serverErrorNotified = false;
		currentCtx = undefined;
		resetState();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (ctx.mode !== "tui" || event.messageType !== "user") return;
		const parts: string[] = [];
		if (state.connected && (state.activeFile || state.selection)) {
			parts.push(buildContextMessage(state));
		}
		parts.push(...attachments.map((item) => item.content));
		const message = parts.filter(Boolean).join("\n\n");
		if (!message) return;
		attachments = [];
		updateAttachments(ctx);

		// Clear the selection after it has been used so it does not pollute
		// follow-up turns indefinitely.
		const hadSelection = state.selection !== null;
		state.selection = null;
		if (hadSelection) updateStatus(ctx);

		return {
			message: {
				customType: "ide-bridge",
				content: message,
				display: false,
			},
		};
	});

	pi.registerCommand("ide-preview", {
		description: "Preview a pending IDE attachment (optional 1-based attachment number)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return;
			if (!attachments.length) {
				ctx.ui.notify("No pending IDE attachments", "info");
				return;
			}
			const pending = [...attachments];
			let index = args.trim() ? Number(args.trim()) - 1 : 0;
			if (!args.trim() && pending.length > 1) {
				const choices = pending.map((item, i) => `${i + 1}. ${item.label}`);
				const choice = await ctx.ui.select("Preview attachment", choices);
				if (!choice) return;
				index = choices.indexOf(choice);
			}
			const item = Number.isInteger(index) ? pending[index] : undefined;
			if (!item) {
				ctx.ui.notify(`Choose an attachment number from 1 to ${pending.length}`, "warning");
				return;
			}
			attachmentWidget?.closePreview();
			await ctx.ui.custom<void>((tui, theme, _keys, done) => {
				const panel = new PreviewPanel(tui, theme, item, () => done());
				void panel.load();
				return panel;
			}, { overlay: true, overlayOptions: { width: "90%", anchor: "center" } });
		},
	});

	pi.registerCommand("ide-remove-attachment", {
		description: "Remove one pending IDE attachment (optional 1-based attachment number)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return;
			const pending = [...attachments];
			if (!pending.length) {
				ctx.ui.notify("No pending IDE attachments", "info");
				return;
			}
			let index = args.trim() ? Number(args.trim()) - 1 : 0;
			if (!args.trim() && pending.length > 1) {
				const choices = pending.map((item, i) => `${i + 1}. ${item.label}`);
				const choice = await ctx.ui.select("Remove attachment", choices);
				if (!choice) return;
				index = choices.indexOf(choice);
			}
			const item = Number.isInteger(index) ? pending[index] : undefined;
			if (!item) {
				ctx.ui.notify(`Choose an attachment number from 1 to ${pending.length}`, "warning");
				return;
			}
			removeAttachment(ctx, item);
		},
	});

	pi.registerCommand("ide-clear-attachments", {
		description: "Remove all pending IDE attachments from the next prompt",
		handler: async (_args, ctx) => {
			attachments = [];
			state.selection = null;
			updateAttachments(ctx);
			updateStatus(ctx);
		},
	});

	pi.registerCommand("ide-state", {
		description: "Show IDE bridge state",
		handler: async (_args, ctx) => {
			const lines = [
				`Bound port: ${boundPort ?? "none"}`,
				`Connected: ${state.connected ? "yes" : "no"}`,
				`Editor: ${state.editor ?? "none"}`,
				`Active file: ${state.activeFile ?? "none"}`,
				`Workspace roots: ${state.workspaceRoots.length}`,
				`Open files: ${state.openFiles.length}`,
			];
			if (state.selection) {
				lines.push(
					`Selection: lines ${state.selection.startLine + 1}-${state.selection.endLine + 1} (${state.selection.text.length} chars)`,
				);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("ide-bridge-port", {
		description: "Show the IDE bridge port range",
		handler: async (_args, ctx) => {
			const basePort = getBasePort();
			ctx.ui.notify(
				`Base port: ${basePort}, range: ${basePort}-${basePort + MAX_PORT_ATTEMPTS - 1}, current: ${boundPort ?? "not bound"}`,
				"info",
			);
		},
	});

	pi.registerCommand("ide-insert-active-file", {
		description: "Attach the active IDE file to the next prompt",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			if (!state.activeFile) {
				ctx.ui.notify("No active IDE file", "warning");
				return;
			}
			insertIntoEditor(ctx, { type: "file", path: state.activeFile });
		},
	});

	pi.registerCommand("ide-insert-selection", {
		description: "Attach the current IDE selection to the next prompt",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			if (!state.selection?.text) {
				ctx.ui.notify("No IDE selection", "warning");
				return;
			}
			insertIntoEditor(ctx, { type: "text", text: state.selection.text });
		},
	});

	pi.registerCommand("ide-open-files", {
		description: "Pick an open IDE file and attach it to the next prompt",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			if (!state.connected || state.openFiles.length === 0) {
				ctx.ui.notify("No open IDE files", "warning");
				return;
			}
			const uniqueFiles = Array.from(new Set(state.openFiles));
			const chosen = await ctx.ui.select("Open IDE files", uniqueFiles);
			if (!chosen) return;
			insertIntoEditor(ctx, { type: "file", path: chosen });
		},
	});

	pi.registerCommand("ide-clear-selection", {
		description: "Clear the cached IDE selection",
		handler: async (_args, ctx) => {
			if (state.selection) {
				state.selection = null;
				updateStatus(ctx);
			}
			ctx.ui.notify("IDE selection cleared", "info");
		},
	});

	pi.registerCommand("ide", {
		description: "Install the companion VS Code/Cursor/Trae extension (/ide init)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				// eslint-disable-next-line no-console
				console.log("/ide init is only available in Pi's interactive TUI.");
				return;
			}

			const subcommand = args.trim().toLowerCase();
			if (subcommand !== "init") {
				ctx.ui.notify("Usage: /ide init  (installs the companion IDE extension)", "warning");
				return;
			}

			ctx.ui.notify("🔍 Checking for the latest companion IDE extension...", "info");

			let release: { version: string; assetUrl: string; assetName: string };
			try {
				release = await fetchLatestRelease();
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(
					`Could not fetch latest release: ${message}\nPlease install manually from https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
					"error",
				);
				return;
			}

			ctx.ui.notify(`📦 Latest companion extension: ${release.version}`, "info");

			let editors: DetectedEditor[];
			try {
				editors = await detectInstalledEditors(pi);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Could not detect editors: ${message}`, "error");
				return;
			}

			if (editors.length === 0) {
				ctx.ui.notify(
					"No supported editor CLI found on PATH.\nSupported: code, code-insiders, cursor, trae, trae.cn\nMake sure your editor's command line tools are installed, then run /ide init again.",
					"warning",
				);
				return;
			}

			const editorList = editors.map((e) => `${e.name} (${e.version})`).join(", ");
			ctx.ui.notify(`Detected editors: ${editorList}`, "info");

			const confirmed = await ctx.ui.confirm(
				"Install Pi IDE Bridge companion extension?",
				`Editors: ${editorList}\n\nThis will download ${release.assetName} and install it into each detected editor.`,
			);
			if (!confirmed) {
				ctx.ui.notify("Installation cancelled.", "info");
				return;
			}

			let vsixPath: string;
			try {
				vsixPath = await downloadVsix(release.assetUrl, release.assetName);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Download failed: ${message}`, "error");
				return;
			}

			ctx.ui.notify("Installing companion extension...", "info");

			const results: string[] = [];
			for (const editor of editors) {
				ctx.ui.notify(`⏳ Installing for ${editor.name}...`, "info");
				const result = await installVsix(pi, editor.cli, vsixPath);
				if (result.code === 0) {
					results.push(`✅ ${editor.name}: installed`);
				} else {
					const detail = (result.stderr || result.stdout || "unknown error").trim();
					results.push(`❌ ${editor.name}: ${detail}`);
				}
			}

			try {
				await fsp.unlink(vsixPath);
			} catch {
				// Ignore cleanup failure.
			}

			ctx.ui.notify(`Installation results:\n${results.join("\n")}`, "info");
			ctx.ui.notify(
				"🔄 If the companion extension does not activate automatically, reload your editor window (Command Palette → 'Developer: Reload Window').",
				"info",
			);
		},
	});

	pi.registerShortcut("ctrl+shift+a" as KeyId, {
		description: "Attach the active IDE file to the next prompt",
		handler: (ctx) => {
			if (ctx.mode !== "tui") return;
			if (!state.activeFile) {
				ctx.ui.notify("No active IDE file", "warning");
				return;
			}
			insertIntoEditor(ctx, { type: "file", path: state.activeFile });
		},
	});

	pi.registerShortcut("ctrl+shift+s" as KeyId, {
		description: "Attach the current IDE selection to the next prompt",
		handler: (ctx) => {
			if (ctx.mode !== "tui") return;
			if (!state.selection?.text) {
				ctx.ui.notify("No IDE selection", "warning");
				return;
			}
			insertIntoEditor(ctx, { type: "text", text: state.selection.text });
		},
	});
}
