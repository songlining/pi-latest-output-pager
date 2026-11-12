import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionInfo } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import { Input, Key, Markdown, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { appendFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Debug aid: `touch /tmp/latest-output-pager.log` to trace auto-open and
// live-insert decisions. Silent while the file does not exist.
const DEBUG_LOG = "/tmp/latest-output-pager.log";
function debugLog(line: string): void {
	if (!existsSync(DEBUG_LOG)) return;
	try {
		appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${line}\n`);
	} catch {
		// Never let diagnostics break the pager.
	}
}

const AUTO_OPEN_FALLBACK_MIN_CHARS = 1200;
// Cap the question shown in the picker row and pager title so a huge pasted
// quote doesn't wrap across the whole screen. Both surfaces derive from the
// label, so truncating here fixes both.
const MAX_QUESTION_LABEL_WIDTH = 160;
const STATUS_KEY = "latest-output-pager";
const DIMENSIONS_WIDGET_KEY = "latest-output-pager-dimensions";

type AnyMessage = {
	role?: string;
	content?: unknown;
};

type SessionEntryLike = {
	type?: string;
	customType?: string;
	data?: unknown;
};

type CodexGoalStatus = "active" | "paused" | "budgetLimited" | "complete";

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const record = part as Record<string, unknown>;
			if (record.type === "text" && typeof record.text === "string") return record.text;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function latestAssistantText(messages: AnyMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		const text = textFromContent(message.content).trim();
		if (text.length > 0) return text;
	}
	return undefined;
}

// The question that produced the last substantive assistant message.
function latestUserQuestion(messages: AnyMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role !== "assistant") continue;
		for (let j = i - 1; j >= 0; j--) {
			if (messages[j]?.role !== "user") continue;
			const question = textFromContent(messages[j].content).replace(/\s+/g, " ").trim();
			if (question) return question;
		}
		break;
	}
	return undefined;
}

function formatSessionLabel(session: SessionInfo, index: number, currentSessionFile: string | undefined, includeCwd: boolean): string {
	const title = (session.name || session.firstMessage || "Untitled session").replace(/\s+/g, " ").trim();
	const shortTitle = visibleWidth(title) > 72 ? truncateToWidth(title, 72, "…") : title;
	const modified = session.modified.toLocaleString();
	const current = currentSessionFile && session.path === currentSessionFile ? " current" : "";
	const cwd = includeCwd && session.cwd ? ` · ${session.cwd}` : "";
	return `${String(index + 1).padStart(2, "0")}. ${shortTitle} · ${modified} · ${session.messageCount} messages${current}${cwd}`;
}

type QuestionAnswerChoice = {
	label: string;
	answer: string;
	timestampMs: number;
};

type PickerChoice<T> = {
	label: string;
	value: T;
};

type MessageEntryLike = {
	type?: string;
	timestamp?: string;
	message?: AnyMessage;
};

function latestAssistantTextFromSessionFile(sessionFile: string): string | undefined {
	const session = SessionManager.open(sessionFile);
	const leafId = session.getLeafId() ?? undefined;
	const messages = session
		.getBranch(leafId)
		.filter((entry) => entry.type === "message")
		.map((entry) => entry.message) as AnyMessage[];
	return latestAssistantText(messages);
}

function questionAnswerChoicesFromEntries(entries: MessageEntryLike[], session: SessionInfo | undefined, currentSessionFile: string | undefined, includeCwd: boolean): QuestionAnswerChoice[] {
	const choices: QuestionAnswerChoice[] = [];
	let pending: { question: string; answer?: string; timestamp?: string } | undefined;

	function flushPending() {
		if (!pending?.question || !pending.answer) return;
		const index = choices.length + 1;
		const rawQuestion = pending.question.replace(/\s+/g, " ").trim() || "Untitled question";
		const question = visibleWidth(rawQuestion) > MAX_QUESTION_LABEL_WIDTH ? truncateToWidth(rawQuestion, MAX_QUESTION_LABEL_WIDTH, "…") : rawQuestion;
		const when = pending.timestamp ? new Date(pending.timestamp).toLocaleString() : (session?.modified.toLocaleString() ?? "unknown time");
		// Only label the row with the session for entries from OTHER sessions (cross-session
		// browse). For the current session it's redundant — and when the session is unnamed it
		// falls back to the first message (itself a question), so a single row reads as two.
		const isCurrentSession = currentSessionFile !== undefined && session?.path === currentSessionFile;
		const sessionTitle = isCurrentSession ? "" : (session?.name || session?.firstMessage || "Current session").replace(/\s+/g, " ").trim();
		const shortSessionTitle = visibleWidth(sessionTitle) > 48 ? truncateToWidth(sessionTitle, 48, "…") : sessionTitle;
		const current = isCurrentSession ? " · current" : "";
		const cwd = includeCwd && session?.cwd ? ` · ${session.cwd}` : "";
		choices.push({
			label: `${String(index).padStart(2, "0")}. ${question} · ${when}${shortSessionTitle ? ` · ${shortSessionTitle}` : ""}${current}${cwd}`,
			answer: pending.answer,
			timestampMs: pending.timestamp ? new Date(pending.timestamp).getTime() : (session?.modified.getTime() ?? 0),
		});
	}

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message?.role === "user") {
			flushPending();
			const question = textFromContent(message.content).trim();
			pending = question ? { question, timestamp: entry.timestamp } : undefined;
			continue;
		}

		if (message?.role === "assistant" && pending) {
			const answer = textFromContent(message.content).trim();
			if (answer) pending.answer = answer;
		}
	}

	flushPending();
	return choices;
}

function questionAnswerChoicesFromSessionFile(sessionInfo: SessionInfo, currentSessionFile: string | undefined, includeCwd: boolean): QuestionAnswerChoice[] {
	const session = SessionManager.open(sessionInfo.path);
	const leafId = session.getLeafId() ?? undefined;
	return questionAnswerChoicesFromEntries(session.getBranch(leafId) as MessageEntryLike[], sessionInfo, currentSessionFile, includeCwd);
}

function copyTextToClipboard(text: string): { ok: true; command: string } | { ok: false; error: string } {
	const commands: Array<{ command: string; args: string[] }> = [
		{ command: "pbcopy", args: [] },
		{ command: "wl-copy", args: [] },
		{ command: "xclip", args: ["-selection", "clipboard"] },
		{ command: "xsel", args: ["--clipboard", "--input"] },
	];

	const errors: string[] = [];
	for (const candidate of commands) {
		const result = spawnSync(candidate.command, candidate.args, {
			input: text,
			encoding: "utf8",
			stdio: ["pipe", "ignore", "pipe"],
			// A wedged clipboard helper must not freeze the TUI event loop.
			timeout: 5000,
		});

		if (!result.error && result.status === 0) return { ok: true, command: candidate.command };
		if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") continue;
		const message = result.error?.message || result.stderr?.trim() || `${candidate.command} exited with ${result.status}`;
		errors.push(`${candidate.command}: ${message}`);
	}

	return {
		ok: false,
		error: errors.length > 0 ? errors.join("; ") : "No supported clipboard command found (tried pbcopy, wl-copy, xclip, xsel)",
	};
}

function latestCodexGoalStatus(entries: SessionEntryLike[]): CodexGoalStatus | null | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "custom" || entry.customType !== "pi-codex-goal") continue;
		const data = entry.data;
		if (!data || typeof data !== "object") continue;
		const record = data as Record<string, unknown>;

		if (record.kind === "clear") return null;

		if (record.kind === "usage" && typeof record.status === "string") {
			return record.status as CodexGoalStatus;
		}

		if (record.kind === "set" && record.goal && typeof record.goal === "object") {
			const goal = record.goal as Record<string, unknown>;
			if (typeof goal.status === "string") return goal.status as CodexGoalStatus;
		}
	}

	return undefined;
}

function hasActiveCodexGoal(ctx: ExtensionContext): boolean {
	try {
		const status = latestCodexGoalStatus(ctx.sessionManager.getBranch() as SessionEntryLike[]);
		return status === "active";
	} catch {
		return false;
	}
}

function padToWidth(text: string, width: number): string {
	const truncated = visibleWidth(text) > width ? truncateToWidth(text, width, "") : text;
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function stripAnsi(text: string): string {
	return text
		.replace(/\x1b\[[0-9;?]*m/g, "")
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

// Vim-style search highlight: reverse-video (SGR 7/27) like vim's hlsearch.
function highlightPlain(text: string, query: string): string {
	if (!text || !query) return text;
	const lower = text.toLowerCase();
	const q = query.toLowerCase();
	if (!lower.includes(q)) return text;
	const out: string[] = [];
	let idx = 0;
	while (true) {
		const pos = lower.indexOf(q, idx);
		if (pos === -1) {
			out.push(text.slice(idx));
			break;
		}
		out.push(text.slice(idx, pos), `\x1b[7m${text.slice(pos, pos + q.length)}\x1b[27m`);
		idx = pos + q.length;
	}
	return out.join("");
}

// ANSI-aware variant for rendered markdown lines: highlight the query in the
// visible text while preserving the line's existing colour/syntax codes.
function highlightAnsi(line: string, query: string): string {
	if (!line || !query) return line;
	const stripped = stripAnsi(line);
	const q = query.toLowerCase();
	if (!stripped.toLowerCase().includes(q)) return line;

	// Split the original line into ANSI runs and plain-text runs.
	const ansiRe = /\x1b\[[0-9;?]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
	const tokens: Array<{ type: "ansi"; value: string } | { type: "text"; value: string }> = [];
	let lastIndex = 0;
	for (const m of line.matchAll(ansiRe)) {
		if ((m.index ?? 0) > lastIndex) tokens.push({ type: "text", value: line.slice(lastIndex, m.index) });
		tokens.push({ type: "ansi", value: m[0] });
		lastIndex = (m.index ?? 0) + m[0].length;
	}
	if (lastIndex < line.length) tokens.push({ type: "text", value: line.slice(lastIndex) });

	// All match spans in the stripped text.
	const spans: Array<[number, number]> = [];
	const low = stripped.toLowerCase();
	let idx = 0;
	while (true) {
		const pos = low.indexOf(q, idx);
		if (pos === -1) break;
		spans.push([pos, pos + q.length]);
		idx = pos + q.length;
	}
	if (spans.length === 0) return line;

	let out = "";
	let plainOffset = 0;
	let spanIdx = 0;
	for (const token of tokens) {
		if (token.type === "ansi") {
			out += token.value;
			continue;
		}
		const t = token.value;
		let localStart = 0;
		while (spanIdx < spans.length) {
			const [start, end] = spans[spanIdx];
			if (end <= plainOffset) {
				spanIdx++;
				continue;
			}
			if (start >= plainOffset + t.length) break;
			const s = Math.max(0, start - plainOffset);
			const e = Math.min(t.length, end - plainOffset);
			if (s > localStart) out += t.slice(localStart, s);
			out += `\x1b[7m${t.slice(s, e)}\x1b[27m`;
			localStart = e;
			if (end <= plainOffset + t.length) spanIdx++;
		}
		if (localStart < t.length) out += t.slice(localStart);
		plainOffset += t.length;
	}
	return out;
}

class HistoryPicker<T> implements Component {
	private selected = 0;
	private scroll = 0;
	private searchActive = false;
	private searchQuery = "";
	private searchBackward = false;
	private lastQuery: string | undefined;
	private searchStatus: string | undefined;
	private wrapWidth = 100;
	private cachedLayout:
		| { width: number; data: { wraps: string[][]; starts: number[]; totalLines: number } }
		| undefined;

	constructor(
		private readonly title: string,
		private readonly choices: PickerChoice<T>[],
		private readonly getRows: () => number,
		private readonly theme: ExtensionContext["ui"]["theme"],
		private readonly done: (choice: PickerChoice<T> | undefined) => void,
	) {}

	handleInput(data: string): void {
		const page = this.bodyHeight();

		// Vim-style search mode: " / " starts a forward search, "?" starts a backward search
		if (this.searchActive) {
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
				this.searchActive = false;
				this.searchQuery = "";
				return;
			}
			if (matchesKey(data, Key.enter)) {
				this.lastQuery = this.searchQuery;
				this.searchActive = false;
				this.searchQuery = "";
				this.performSearch(this.searchBackward);
				return;
			}
			if (matchesKey(data, Key.backspace)) {
				this.searchQuery = this.searchQuery.slice(0, -1);
				return;
			}
			if (data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) < 127) {
				this.searchQuery += data;
			}
			return;
		}

		if (data === "/") {
			this.searchActive = true;
			this.searchQuery = "";
			this.searchBackward = false;
			this.searchStatus = undefined;
			return;
		}
		if (data === "?") {
			this.searchActive = true;
			this.searchQuery = "";
			this.searchBackward = true;
			this.searchStatus = undefined;
			return;
		}
		if ((data === "n" || data === "N") && this.lastQuery !== undefined) {
			this.performSearch(data === "N");
			return;
		}

		if (data === "q" || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.done(this.choices[this.selected]);
			return;
		}
		if (matchesKey(data, Key.down) || data === "j") {
			this.selected = Math.min(this.choices.length - 1, this.selected + 1);
			this.ensureVisible();
			return;
		}
		if (matchesKey(data, Key.up) || data === "k") {
			this.selected = Math.max(0, this.selected - 1);
			this.ensureVisible();
			return;
		}
		if (matchesKey(data, Key.space) || matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("f"))) {
			// Page down: move to the choice that starts at (or just past) the next screen boundary.
			const layout = this.layout();
			const target = this.scroll + page;
			let idx = this.selected + 1;
			for (let i = 0; i < this.choices.length; i++) {
				if (layout.starts[i] >= target) { idx = i; break; }
			}
			if (idx <= this.selected) idx = Math.min(this.choices.length - 1, this.selected + 1);
			this.selected = Math.min(this.choices.length - 1, idx);
			this.ensureVisible();
			return;
		}
		if (data === "b" || matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("b"))) {
			// Page up: move to the first choice at the previous screen boundary.
			const layout = this.layout();
			const target = Math.max(0, this.scroll - page);
			let idx = this.selected;
			for (let i = 0; i < this.choices.length; i++) {
				if (layout.starts[i] >= target) { idx = i; break; }
			}
			if (idx >= this.selected) idx = Math.max(0, this.selected - 1);
			this.selected = Math.max(0, idx);
			this.ensureVisible();
			return;
		}
		if (data === "g" || matchesKey(data, Key.home)) {
			this.selected = 0;
			this.ensureVisible();
			return;
		}
		if (data === "G" || matchesKey(data, Key.end)) {
			this.selected = this.choices.length - 1;
			this.ensureVisible();
		}
	}

	private performSearch(backward: boolean): void {
		if (!this.lastQuery) return;
		const query = this.lastQuery.toLowerCase();
		const n = this.choices.length;
		const match = (i: number) => this.choices[i]?.label.toLowerCase().includes(query) ?? false;
		let found = -1;
		if (backward) {
			for (let i = this.selected - 1; i >= 0; i--) if (match(i)) { found = i; break; }
			if (found === -1) for (let i = n - 1; i > this.selected; i--) if (match(i)) { found = i; break; }
		} else {
			for (let i = this.selected + 1; i < n; i++) if (match(i)) { found = i; break; }
			if (found === -1) for (let i = 0; i <= this.selected; i++) if (match(i)) { found = i; break; }
		}
		if (found >= 0) {
			this.selected = found;
			this.ensureVisible();
			this.searchStatus = undefined;
		} else {
			this.searchStatus = `No match: "${this.lastQuery}"`;
		}
	}

	render(width: number): string[] {
		const safeWidth = Math.max(24, width);
		const innerWidth = Math.max(1, safeWidth - 4);
		const bodyHeight = this.bodyHeight();
		// Label width available after the two-char cursor/indent prefix.
		this.wrapWidth = Math.max(1, innerWidth - 2);
		const layout = this.layout();
		this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, layout.totalLines - bodyHeight)));

		// Which choices are actually on screen (used by the help text).
		let firstVisible = -1;
		let lastVisible = -1;
		for (let i = 0; i < this.choices.length; i++) {
			const start = layout.starts[i];
			const endLine = start + layout.wraps[i].length;
			if (endLine > this.scroll && start < this.scroll + bodyHeight) {
				if (firstVisible === -1) firstVisible = i;
				lastVisible = i;
			}
		}
		const shownStart = firstVisible === -1 ? 1 : firstVisible + 1;
		const shownEnd = lastVisible === -1 ? 0 : lastVisible + 1;

		const border = this.theme.fg("border", "─".repeat(Math.max(0, safeWidth - 2)));
		const title = this.theme.fg("accent", this.title);
		const help = this.searchActive
			? this.theme.fg("accent", `${this.searchBackward ? "?" : "/"}${this.searchQuery}`)
			: this.searchStatus
				? this.theme.fg("warning", this.searchStatus)
				: this.theme.fg("dim", `Enter open answer · ↑/↓ move · Space/PgDn page · g/G top/end · / ? search · n/N next/prev · q/Esc cancel · ${shownStart}-${shownEnd} / ${this.choices.length}`);

		const lines: string[] = [];
		lines.push(truncateToWidth(`┌${border}┐`, safeWidth, ""));
		lines.push(`│ ${padToWidth(title, innerWidth)} │`);
		lines.push(`│ ${padToWidth(help, innerWidth)} │`);
		lines.push(truncateToWidth(`├${border}┤`, safeWidth, ""));

		const searchTerm = this.searchActive ? this.searchQuery : (this.lastQuery ?? "");
		const pageLines: string[] = [];
		for (let i = 0; i < this.choices.length; i++) {
			const start = layout.starts[i];
			if (start + layout.wraps[i].length <= this.scroll) continue; // fully above viewport
			if (start >= this.scroll + bodyHeight) break; // fully below viewport
			const isSelected = i === this.selected;
			const cursor = isSelected ? this.theme.fg("accent", "> ") : "  ";
			for (let j = 0; j < layout.wraps[i].length; j++) {
				const lineNo = start + j;
				if (lineNo < this.scroll || lineNo >= this.scroll + bodyHeight) continue;
				// Wrap first, then highlight, so ANSI highlight never gets cut mid-sequence.
				const prefix = j === 0 ? cursor : "  ";
				let row = `${prefix}${highlightPlain(layout.wraps[i][j], searchTerm)}`;
				if (isSelected) row = this.theme.bg("selectedBg", row);
				pageLines.push(padToWidth(row, innerWidth));
			}
		}
		while (pageLines.length < bodyHeight) pageLines.push(padToWidth("", innerWidth));

		for (const line of pageLines) {
			lines.push(`│ ${line} │`);
		}

		lines.push(truncateToWidth(`└${border}┘`, safeWidth, ""));
		return lines.map((line) => (visibleWidth(line) > safeWidth ? truncateToWidth(line, safeWidth, "") : line));
	}

	invalidate(): void {}

	private layout(): { wraps: string[][]; starts: number[]; totalLines: number } {
		if (this.cachedLayout && this.cachedLayout.width === this.wrapWidth) return this.cachedLayout.data;
		const wraps = this.choices.map((choice) => wrapTextWithAnsi(choice.label, this.wrapWidth));
		const starts: number[] = [];
		let totalLines = 0;
		for (const wrapped of wraps) {
			starts.push(totalLines);
			totalLines += wrapped.length;
		}
		const data = { wraps, starts, totalLines };
		this.cachedLayout = { width: this.wrapWidth, data };
		return data;
	}

	private bodyHeight(): number {
		return Math.max(3, this.getRows() - 5);
	}

	private ensureVisible(): void {
		const page = this.bodyHeight();
		const layout = this.layout();
		const start = layout.starts[this.selected];
		const endLine = start + layout.wraps[this.selected].length;
		if (start < this.scroll) this.scroll = start;
		else if (endLine > this.scroll + page) this.scroll = endLine - page;
		const maxScroll = Math.max(0, layout.totalLines - page);
		this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
	}
}

async function pickHistoryChoice<T>(ctx: ExtensionContext, title: string, choices: PickerChoice<T>[]): Promise<PickerChoice<T> | undefined> {
	openOverlays++;
	try {
		// return await so the counter survives until the overlay closes.
		return await ctx.ui.custom<PickerChoice<T> | undefined>((tui, theme, _keybindings, done) => {
			return new HistoryPicker(title, choices, () => tui.terminal.rows, theme, done);
		}, {
			overlay: true,
			overlayOptions: {
				width: "100%",
				margin: 0,
			},
		});
	} finally {
		openOverlays--;
	}
}

type PagerPage = {
	title: string;
	getText: () => string;
};

/**
 * vim-style printable key intents for the pager. Pure so it is testable without
 * a terminal: `data` is the raw key string, `pending` the accumulated count
 * prefix ("", "1", "12", ...). ctrl+u/ctrl+d are resolved by the caller
 * because they arrive as escape sequences, not printable characters.
 */
export type ViKeyIntent =
	| { kind: "scroll"; unit: "line" | "full"; dir: 1 | -1; count: number }
	| { kind: "goto"; line: number | "top" | "bottom" };

export function resolveViKey(data: string, pending: string): ViKeyIntent | { pending: string } | undefined {
	// Count prefix: 1G, 5j, 3Space. Bare "0" is a no-op (there is no line 0).
	if (/^[0-9]$/.test(data)) {
		if (data === "0" && pending === "") return undefined;
		return { pending: (pending + data).slice(0, 6) };
	}

	const count = pending === "" ? 1 : Number.parseInt(pending, 10);
	switch (data) {
		case "j": return { kind: "scroll", unit: "line", dir: 1, count };
		case "k": return { kind: "scroll", unit: "line", dir: -1, count };
		case " ": return { kind: "scroll", unit: "full", dir: 1, count };
		case "b": return { kind: "scroll", unit: "full", dir: -1, count };
		case "g": return { kind: "goto", line: "top" };
		case "G": return pending === "" ? { kind: "goto", line: "bottom" } : { kind: "goto", line: count };
		default: return undefined;
	}
}

// Page titles are baked with their position when their list is built; the live
// prepend in prependPage shifts positions, so renumber when rendering instead.
function renumberTitle(title: string, index: number): string {
	return title.replace(/^(\s*)\d+\./, `$1${String(index + 1).padStart(2, "0")}.`);
}

export class LatestOutputPager implements Component {
	private scroll = 0;
	private pendingCount = "";
	private index: number;
	private searchActive = false;
	private searchQuery = "";
	private searchBackward = false;
	private lastQuery: string | undefined;
	private searchStatus: string | undefined;
	private lastInnerWidth: number | undefined;
	private cachedContentWidth?: number;
	private cachedMarkdownLines?: string[];
	private helpStatus: string | undefined;
	private pageText: string | undefined;
	private pageStatus: string | undefined;
	private titleWrapLines = 1;
	// Follow-up question typed while reading: the block sits under the help line
	// so the page being read never moves, and the reply lands one page left.
	private asking = false;
	private readonly askInput = new Input();

	constructor(
		private readonly getRows: () => number,
		private readonly pages: PagerPage[],
		initialIndex: number,
		private readonly theme: ExtensionContext["ui"]["theme"],
		private readonly done: () => void,
		private readonly ask?: (question: string) => Promise<void>,
		private readonly requestRender: () => void = () => {},
	) {
		this.index = Math.max(0, Math.min(initialIndex, pages.length - 1));
		this.askInput.onSubmit = (value) => this.sendQuestion(value);
		this.askInput.onEscape = () => this.closeAsk();
		this.loadCurrentPage();
	}

	/**
	 * Live update while the pager stays open (see the agent_end handler): a newer
	 * answer becomes page 1 and the page being read keeps its content, its
	 * position number just advancing by one.
	 */
	prependPage(page: PagerPage): void {
		this.pages.unshift(page);
		this.index++;
		this.invalidate();
		this.helpStatus = "New answer added — press ← to read it";
	}

	handleInput(data: string): void {
		// Question entry takes every key, including q/space/escape.
		if (this.asking) {
			this.askInput.handleInput(data);
			return;
		}

		// Vim-style search mode: " / " starts a forward search, "?" starts a backward search
		if (this.searchActive) {
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
				this.searchActive = false;
				this.searchQuery = "";
				return;
			}
			if (matchesKey(data, Key.enter)) {
				this.lastQuery = this.searchQuery;
				this.searchActive = false;
				this.searchQuery = "";
				this.performSearch(this.searchBackward);
				return;
			}
			if (matchesKey(data, Key.backspace)) {
				this.searchQuery = this.searchQuery.slice(0, -1);
				return;
			}
			if (data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) < 127) {
				this.searchQuery += data;
			}
			return;
		}

		if (data === "q" || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done();
			return;
		}

		if (data === "/") {
			this.searchActive = true;
			this.searchQuery = "";
			this.searchBackward = false;
			this.searchStatus = undefined;
			this.pendingCount = "";
			return;
		}
		if (data === "?") {
			this.searchActive = true;
			this.searchQuery = "";
			this.searchBackward = true;
			this.searchStatus = undefined;
			this.pendingCount = "";
			return;
		}
		if ((data === "n" || data === "N") && this.lastQuery !== undefined) {
			this.performSearch(data === "N");
			return;
		}

		// Navigate between conversations (only meaningful when more than one page)
		if (matchesKey(data, Key.left)) {
			if (this.pages.length > 1 && this.index > 0) {
				this.index--;
				this.loadCurrentPage();
				this.invalidate();
			}
			return;
		}
		if (matchesKey(data, Key.right)) {
			if (this.pages.length > 1 && this.index < this.pages.length - 1) {
				this.index++;
				this.loadCurrentPage();
				this.invalidate();
			}
			return;
		}

		// Asking does not need page text, so it stays available on a page that
		// failed to load (the page you most likely want to ask about).
		if (data === "a" && this.ask) {
			this.asking = true;
			// Focus so the terminal draws the hardware cursor / IME anchor in the input.
			this.askInput.focused = true;
			this.pendingCount = "";
			this.searchStatus = undefined;
			this.invalidate();
			return;
		}

		// If the current conversation failed to load, only quit/navigation work
		if (!this.pageText) return;

		const page = this.bodyHeight();
		const max = this.maxScroll();
		const clamp = (value: number) => Math.max(0, Math.min(max, value));

		// vim-style printable keys: [count]j / [count]k, [count]Space, [count]b, g, [count]G
		const vi = resolveViKey(data, this.pendingCount);
		if (vi && "pending" in vi) {
			this.pendingCount = vi.pending;
			return;
		}
		// Any non-digit key ends the count prefix; the branches below consume it.
		const count = this.pendingCount === "" ? 1 : Number.parseInt(this.pendingCount, 10);
		this.pendingCount = "";
		if (vi) {
			if (vi.kind === "goto") {
				this.scroll = vi.line === "top" ? 0 : vi.line === "bottom" ? max : clamp(vi.line - 1);
			} else {
				const unit = vi.unit === "line" ? 1 : Math.max(1, page - 1);
				this.scroll = clamp(this.scroll + vi.dir * unit * vi.count);
			}
			this.invalidate();
			return;
		}

		// vim half-page scroll: ctrl+d down, ctrl+u up
		const halfDown = matchesKey(data, Key.ctrl("d"));
		if (halfDown || matchesKey(data, Key.ctrl("u"))) {
			this.scroll = clamp(this.scroll + (halfDown ? 1 : -1) * Math.max(1, Math.floor(page / 2)) * count);
			this.invalidate();
			return;
		}

		// Full page down/up. Shift/ctrl variants cover keyboards without dedicated
		// PgDn/PgUp keys (Mac Fn+arrow sends the shifted sequence).
		if (
			matchesKey(data, Key.space) ||
			matchesKey(data, Key.pageDown) ||
			matchesKey(data, Key.shift("pageDown")) ||
			matchesKey(data, Key.ctrl("pageDown")) ||
			matchesKey(data, Key.ctrl("f"))
		) {
			this.scroll = clamp(this.scroll + Math.max(1, page - 1) * count);
			this.invalidate();
			return;
		}

		if (
			matchesKey(data, Key.pageUp) ||
			matchesKey(data, Key.shift("pageUp")) ||
			matchesKey(data, Key.ctrl("pageUp")) ||
			matchesKey(data, Key.ctrl("b"))
		) {
			this.scroll = clamp(this.scroll - Math.max(1, page - 1) * count);
			this.invalidate();
			return;
		}

		if (data === "c") {
			const result = copyTextToClipboard(this.pageText);
			this.helpStatus = result.ok ? `Copied to clipboard via ${result.command}` : `Copy failed: ${result.error}`;
			this.invalidate();
			return;
		}

		if (matchesKey(data, Key.down) || matchesKey(data, Key.enter)) {
			this.scroll = clamp(this.scroll + count);
			this.invalidate();
			return;
		}

		if (matchesKey(data, Key.up)) {
			this.scroll = clamp(this.scroll - count);
			this.invalidate();
			return;
		}

		if (matchesKey(data, Key.home)) {
			this.scroll = 0;
			this.invalidate();
			return;
		}

		if (matchesKey(data, Key.end)) {
			this.scroll = max;
			this.invalidate();
		}
	}

	private closeAsk(): void {
		this.asking = false;
		this.askInput.focused = false;
		this.askInput.setValue("");
		this.invalidate();
	}

	private sendQuestion(value: string): void {
		const question = value.trim();
		this.closeAsk();
		if (!question || !this.ask) return;
		this.helpStatus = "Question sent — waiting for the answer (it lands one page left)";
		void this.ask(question).catch((error) => {
			this.helpStatus = `Send failed: ${error instanceof Error ? error.message : String(error)}`;
			this.invalidate();
			this.requestRender();
		});
	}

	private performSearch(backward: boolean): void {
		if (!this.lastQuery || !this.pageText) return;
		const lines = this.getMarkdownLines(Math.max(1, this.lastInnerWidth ?? 80));
		const query = this.lastQuery.toLowerCase();
		const n = lines.length;
		const match = (i: number) => stripAnsi(lines[i] ?? "").toLowerCase().includes(query);
		let found = -1;
		if (backward) {
			for (let i = this.scroll - 1; i >= 0; i--) if (match(i)) { found = i; break; }
			if (found === -1) for (let i = n - 1; i > this.scroll; i--) if (match(i)) { found = i; break; }
		} else {
			for (let i = this.scroll + 1; i < n; i++) if (match(i)) { found = i; break; }
			if (found === -1) for (let i = 0; i <= this.scroll; i++) if (match(i)) { found = i; break; }
		}
		if (found >= 0) {
			this.scroll = found;
			this.searchStatus = undefined;
		} else {
			this.searchStatus = `No match: "${this.lastQuery}"`;
		}
		this.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(24, width);
		const innerWidth = Math.max(1, safeWidth - 4);
		this.lastInnerWidth = innerWidth;

		const border = this.theme.fg("border", "─".repeat(Math.max(0, safeWidth - 2)));
		const multiPage = this.pages.length > 1;
		const pageIndexStr = multiPage ? ` [${this.index + 1}/${this.pages.length}]` : "";
		const titleText = this.pageText ? renumberTitle(this.pages[this.index].title, this.index) : (this.pageStatus ?? "No content");

		// Provisional sizing (before title wrap) so we can compute the suffix width.
		const provisionalBody = Math.max(3, this.getRows() - 5 - (this.asking ? 1 : 0));
		const provisionalLines = this.pageText ? this.getMarkdownLines(innerWidth) : [];
		const provisionalPos = provisionalLines.length > 0 ? `${Math.min(this.scroll + 1, provisionalLines.length)}-${Math.min(this.scroll + provisionalBody, provisionalLines.length)} / ${provisionalLines.length}` : "";
		const suffix = `${pageIndexStr}  ${provisionalPos}`.trim();
		const maxTitleWidth = Math.max(10, innerWidth - visibleWidth(suffix) - 2);

		// Wrap the title so a long question/session label is fully visible across lines.
		const titleWrapped = wrapTextWithAnsi(titleText, maxTitleWidth);
		this.titleWrapLines = titleWrapped.length;
		const bodyHeight = Math.max(3, this.getRows() - 5 - (this.titleWrapLines - 1) - (this.asking ? 1 : 0));

		const markdownLines = provisionalLines;
		const max = Math.max(0, markdownLines.length - bodyHeight);
		this.scroll = Math.max(0, Math.min(this.scroll, max));
		const titleSuffix = this.theme.fg("dim", suffix);

		const navHints: string[] = [];
		if (multiPage && this.index > 0) navHints.push("← prev conversation");
		if (multiPage && this.index < this.pages.length - 1) navHints.push("-> next conversation");
		const scrollHints = "Space/PgDn next • b/PgUp prev • Ctrl+D/U half page • j/k line • gg/1G top • G end • / ? search • n/N next/prev • a ask • c copy • q quit";
		const baseHelp = navHints.length > 0 ? `${navHints.join(" • ")} • ${scrollHints}` : scrollHints;
		const help = this.asking
			? this.theme.fg("accent", "Ask a follow-up — Enter sends it without leaving the pager · Esc cancel")
			: this.searchActive
				? this.theme.fg("accent", `${this.searchBackward ? "?" : "/"}${this.searchQuery}`)
				: this.searchStatus
					? this.theme.fg("warning", this.searchStatus)
					: this.theme.fg(this.helpStatus?.startsWith("Copy failed") || this.helpStatus?.startsWith("Send failed") ? "error" : "dim", this.helpStatus ?? baseHelp);

		const lines: string[] = [];
		lines.push(truncateToWidth(`┌${border}┐`, safeWidth, ""));
		for (let i = 0; i < titleWrapped.length; i++) {
			let row = titleWrapped[i];
			if (i === titleWrapped.length - 1 && suffix) row = `${row}  ${titleSuffix}`;
			lines.push(`│ ${padToWidth(this.theme.fg("accent", row), innerWidth)} │`);
		}
		lines.push(`│ ${padToWidth(help, innerWidth)} │`);
		if (this.asking) {
			lines.push(`│ ${padToWidth(this.askInput.render(innerWidth)[0] ?? "", innerWidth)} │`);
		}
		lines.push(truncateToWidth(`├${border}┤`, safeWidth, ""));

		const searchTerm = this.searchActive ? this.searchQuery : (this.lastQuery ?? "");
		const pageLines: string[] = [];
		if (this.pageText) {
			pageLines.push(...markdownLines.slice(this.scroll, this.scroll + bodyHeight).map((line) => highlightAnsi(line, searchTerm)));
		} else {
			pageLines.push(this.theme.fg("dim", this.pageStatus ?? "No content"));
		}
		while (pageLines.length < bodyHeight) pageLines.push("");

		for (const line of pageLines) {
			lines.push(`│ ${padToWidth(line, innerWidth)} │`);
		}

		lines.push(truncateToWidth(`└${border}┘`, safeWidth, ""));
		return lines.map((line) => (visibleWidth(line) > safeWidth ? truncateToWidth(line, safeWidth, "") : line));
	}

	invalidate(): void {
		this.cachedContentWidth = undefined;
		this.cachedMarkdownLines = undefined;
	}

	private bodyHeight(): number {
		return Math.max(3, this.getRows() - 5 - (this.titleWrapLines - 1) - (this.asking ? 1 : 0));
	}

	private maxScroll(): number {
		return Math.max(0, (this.cachedMarkdownLines?.length ?? 0) - this.bodyHeight());
	}

	private loadCurrentPage(): void {
		this.scroll = 0;
		this.helpStatus = undefined;
		this.cachedMarkdownLines = undefined;
		try {
			const text = this.pages[this.index].getText();
			if (text && text.trim()) {
				this.pageText = text;
				this.pageStatus = undefined;
			} else {
				this.pageText = undefined;
				this.pageStatus = "No assistant output in this conversation";
			}
		} catch (error) {
			this.pageText = undefined;
			this.pageStatus = `Could not load conversation: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	private getMarkdownLines(contentWidth: number): string[] {
		if (this.cachedMarkdownLines && this.cachedContentWidth === contentWidth) {
			return this.cachedMarkdownLines;
		}

		const markdown = new Markdown(this.pageText ?? "", 0, 0, getMarkdownTheme());
		const lines = markdown.render(contentWidth);
		this.cachedMarkdownLines = lines;
		this.cachedContentWidth = contentWidth;
		return lines;
	}
}

// A pager or picker is a modal overlay: whatever the user is reading must not be
// replaced by an auto-open while one is on screen. A counter because a manually
// opened overlay can nest inside (or replace) another one.
let openOverlays = 0;
// Set while a pager that accepts live page inserts is open (see agent_end).
let livePager: ((page: PagerPage) => void) | undefined;
// Set by the extension so a follow-up typed inside the pager can reach the agent.
let askAgent: ((question: string, ctx: ExtensionContext) => Promise<void>) | undefined;

async function showPager(ctx: ExtensionContext, pages: PagerPage[], initialIndex = 0): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Latest output pager is only available in the interactive TUI", "warning");
		return;
	}
	if (pages.length === 0) return;

	let liveTarget: ((page: PagerPage) => void) | undefined;
	const ask = askAgent ? (question: string) => askAgent!(question, ctx) : undefined;
	openOverlays++;
	debugLog(`showPager pages=${pages.length} index=${initialIndex}`);
	try {
		await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
			const component = new LatestOutputPager(
				() => tui.terminal.rows,
				pages,
				initialIndex,
				theme,
				() => done(undefined),
				ask,
				() => tui.requestRender(),
			);
			// Every pager accepts live inserts: a follow-up asked from inside it, or a
			// turn that finished while browsing history, becomes the page one step left.
			livePager = liveTarget = (page) => {
				component.prependPage(page);
				tui.requestRender();
			};
			return component;
		}, {
			overlay: true,
			overlayOptions: {
				anchor: "top-left",
				row: 0,
				col: 0,
				width: "100%",
				maxHeight: "100%",
				margin: 0,
			},
		});
	} finally {
		if (liveTarget && livePager === liveTarget) livePager = undefined;
		openOverlays--;
	}
}

export default function latestOutputPager(pi: ExtensionAPI) {
	let lastText: string | undefined;
	let autoOpen = true;
	let lastRows: number | undefined;
	let lastColumns: number | undefined;

	// A question typed inside the pager goes in as a normal user message and the
	// pager stays exactly where it is; the reply arrives via the agent_end
	// live-insert path. While a turn is still running it has to be queued, or
	// sendUserMessage rejects a message with no routing hint.
	// pi.sendUserMessage is fire-and-forget (it routes failures to the extension
	// error channel), so a rejection cannot reach the pager. Check the one thing
	// we can see up front instead of leaving the user on a "waiting" line forever.
	askAgent = async (question, ctx) => {
		if (!ctx.model) throw new Error("no model is selected, so nothing can answer");
		pi.sendUserMessage(question, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
	};

	function shouldAutoOpen(text: string): boolean {
		if (lastRows && lastColumns) {
			const contentWidth = Math.max(20, lastColumns - 4);
			const bodyHeight = Math.max(3, lastRows - 5);
			const lines = new Markdown(text, 0, 0, getMarkdownTheme()).render(contentWidth);
			return lines.length > bodyHeight;
		}

		return text.length >= AUTO_OPEN_FALLBACK_MIN_CHARS;
	}

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, autoOpen ? ctx.ui.theme.fg("dim", "latest output pager: auto") : undefined);
		ctx.ui.setWidget(DIMENSIONS_WIDGET_KEY, (tui) => ({
			render(width: number) {
				lastColumns = width;
				lastRows = tui.terminal.rows;
				return [];
			},
			invalidate() {},
		}), { placement: "belowEditor" });
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(DIMENSIONS_WIDGET_KEY, undefined);
	});

	pi.on("agent_end", async (event, ctx) => {
		const text = latestAssistantText(event.messages as AnyMessage[]);
		if (!text) return;
		lastText = text;
		debugLog(`agent_end text=${text.length} autoOpen=${autoOpen} overlays=${openOverlays} live=${livePager ? "yes" : "no"}`);

		// Don't replace what the user is already reading. While an overlay is open
		// (e.g. browsing session history while this turn ran in the background),
		// add the answer to the open pager as page 1 and leave the page being read
		// on screen — its position number just advances by one. The text also
		// lands in lastText, so /latest-output shows it once the pager is closed.
		// This is independent of the auto-open setting: auto-open decides whether a
		// pager opens by itself, not whether an open one gets the new answer.
		if (openOverlays > 0) {
			if (livePager) {
				const rawQuestion = latestUserQuestion(event.messages as AnyMessage[]) ?? "Latest assistant output";
				const question = visibleWidth(rawQuestion) > MAX_QUESTION_LABEL_WIDTH ? truncateToWidth(rawQuestion, MAX_QUESTION_LABEL_WIDTH, "…") : rawQuestion;
				// The "01." is a placeholder; render renumbers pages by position.
				livePager({ title: `01. ${question} · ${new Date().toLocaleString()} · current`, getText: () => text });
				debugLog("inserted new answer as page 1");
			}
			return;
		}

		if (!autoOpen) return;

		// Interop with npm:pi-codex-goal: when a goal is active, that extension may
		// queue a hidden follow-up continuation from its own agent_end handler. If
		// we open the modal pager here, the TUI waits for the user to page/quit the
		// previous assistant output before the continuation can start, making goal
		// runs appear paused. Keep manual /latest-output available, but never
		// auto-open over an active goal continuation boundary.
		if (hasActiveCodexGoal(ctx)) return;

		if (!shouldAutoOpen(text)) return;
		await showLatestResponsePager(ctx, text);
	});

	pi.registerCommand("latest-output", {
		description: "Open the latest assistant output in a less-like pager",
		handler: async (_args, ctx) => {
			if (!lastText) {
				const branchText = latestAssistantText(
					ctx.sessionManager
						.getBranch()
						.filter((entry) => entry.type === "message")
						.map((entry) => entry.message) as AnyMessage[],
				);
				lastText = branchText;
			}

			if (!lastText) {
				ctx.ui.notify("No assistant output found in this session", "warning");
				return;
			}

			const outputText = lastText;
			await showLatestResponsePager(ctx, outputText);
		},
	});

	const openAnswersHistory = async (args: string, ctx: ExtensionCommandContext) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Answers history picker is only available in the interactive TUI", "warning");
			return;
		}

		const parsedArgs = args.trim().split(/\s+/).filter(Boolean);
		const includeAllProjects = parsedArgs.some((arg) => arg === "--all" || arg === "all");
		const sessionMode = parsedArgs.some((arg) => arg === "--sessions" || arg === "sessions");
		const currentSessionFile = ctx.sessionManager.getSessionFile();
		const sessions = (includeAllProjects ? await SessionManager.listAll() : await SessionManager.list(ctx.cwd))
			.sort((a, b) => b.modified.getTime() - a.modified.getTime());

		if (sessions.length === 0) {
			ctx.ui.notify(includeAllProjects ? "No sessions found" : "No sessions found for this project", "warning");
			return;
		}

		if (sessionMode) {
			const sessionChoices: PickerChoice<string>[] = sessions.map((session, index) => ({
				label: formatSessionLabel(session, index, currentSessionFile, includeAllProjects),
				value: session.path,
			}));

			const selected = await pickHistoryChoice(ctx, includeAllProjects ? "Pick a conversation from any project" : "Pick a conversation", sessionChoices);
			if (!selected) return;

			const selectedIndex = Math.max(0, sessionChoices.indexOf(selected));
			const pages: PagerPage[] = sessions.map((session, index) => ({
				title: formatSessionLabel(session, index, currentSessionFile, includeAllProjects),
				getText: () => latestAssistantTextFromSessionFile(session.path) ?? "",
			}));

			await showPager(ctx, pages, selectedIndex);
			return;
		}

		const choices: QuestionAnswerChoice[] = [];
		for (const session of sessions) {
			try {
				choices.push(...questionAnswerChoicesFromSessionFile(session, currentSessionFile, includeAllProjects));
			} catch {
				// Ignore malformed or unreadable session files; the picker should still
				// be useful if one old history file is corrupt.
			}
		}

		if (choices.length === 0) {
			ctx.ui.notify("No answered user questions found in history", "warning");
			return;
		}

		choices.sort((a, b) => b.timestampMs - a.timestampMs);
		const pickerChoices: PickerChoice<string>[] = choices.map((choice, index) => ({
			label: choice.label.replace(/^\s*\d+\./, `${String(index + 1).padStart(2, "0")}.`),
			value: choice.answer,
		}));

		const selected = await pickHistoryChoice(ctx, includeAllProjects ? "Pick one of your questions from any project" : "Pick one of your questions", pickerChoices);
		if (!selected) return;

		const selectedIndex = Math.max(0, pickerChoices.indexOf(selected));
		const pages: PagerPage[] = pickerChoices.map((choice) => ({
			title: choice.label,
			getText: () => choice.value,
		}));

		await showPager(ctx, pages, selectedIndex);
	};

	const currentSessionPickerChoices = async (ctx: ExtensionContext): Promise<PickerChoice<string>[] | undefined> => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Answers history picker is only available in the interactive TUI", "warning");
			return undefined;
		}

		const currentSessionFile = ctx.sessionManager.getSessionFile();
		if (!currentSessionFile) {
			ctx.ui.notify("No current session file", "warning");
			return;
		}

		// Locate the current session's info in the project listing so labels show
		// its title/date; fall back to opening the file directly if it is not
		// listed yet (e.g. brand-new session).
		let sessionInfo: SessionInfo | undefined;
		try {
			const sessions = await SessionManager.list(ctx.cwd);
			sessionInfo = sessions.find((session) => session.path === currentSessionFile);
		} catch {
			// Ignore listing failures; fall through to direct file open.
		}

		let choices: QuestionAnswerChoice[];
		if (sessionInfo) {
			choices = questionAnswerChoicesFromSessionFile(sessionInfo, currentSessionFile, false);
		} else {
			const session = SessionManager.open(currentSessionFile);
			const leafId = session.getLeafId() ?? undefined;
			const entries = session.getBranch(leafId) as MessageEntryLike[];
			choices = questionAnswerChoicesFromEntries(entries, undefined, currentSessionFile, false);
		}

		if (choices.length === 0) {
			ctx.ui.notify("No answered user questions found in the current session", "warning");
			return undefined;
		}

		choices.sort((a, b) => b.timestampMs - a.timestampMs);
		// Most recent answer first, so pager index 0 is the latest response and
		// left-arrow walks back through history.
		return choices.map((choice, index) => ({
			label: choice.label.replace(/^\s*\d+\./, `${String(index + 1).padStart(2, "0")}.`),
			value: choice.answer,
		}));
	};

	const showLatestResponsePager = async (ctx: ExtensionContext, text: string): Promise<void> => {
		// Latest response as page 0, with the rest of this session's Q&As as
		// additional pages so ←/→ walk back through history (same navigation as
		// /history-current-session). Falls back to a single page when the
		// session choices can't be built.
		let pages: PagerPage[] = [{ title: "Latest assistant output", getText: () => text }];
		if (ctx.mode === "tui") {
			try {
				const choices = await currentSessionPickerChoices(ctx);
				if (choices && choices.length > 0) {
					const historyPages = choices.map((choice) => ({ title: choice.label, getText: () => choice.value }));
					// If the session file already flushed this answer it is index 0;
					// otherwise prepend the in-memory latest response so page 0 is always current.
					pages = choices[0].value.trim() === text.trim()
						? historyPages
						: [{ title: "Latest assistant output", getText: () => text }, ...historyPages];
				}
			} catch {
				// Keep the single-page fallback.
			}
		}
		await showPager(ctx, pages, 0);
	};

	const openCurrentSessionHistory = async (_args: string, ctx: ExtensionCommandContext) => {
		const pickerChoices = await currentSessionPickerChoices(ctx);
		if (!pickerChoices) return;

		const selected = await pickHistoryChoice(ctx, "Pick one of your questions in this session", pickerChoices);
		if (!selected) return;

		const selectedIndex = Math.max(0, pickerChoices.indexOf(selected));
		const pages: PagerPage[] = pickerChoices.map((choice) => ({
			title: choice.label,
			getText: () => choice.value,
		}));

		await showPager(ctx, pages, selectedIndex);
	};

	// NOTE (2025): /history-all-sessions is intentionally CROSS-SESSION — it
	// lists all sessions in the current project (or all projects with --all).
	// The current-session-only variant is /history-current-session
	// (openCurrentSessionHistory).
	pi.registerCommand("history-all-sessions", {
		description: "Pick one of your previous questions and open its answer in the pager (usage: /history-all-sessions [--all|--sessions])",
		handler: openAnswersHistory,
	});

	pi.registerCommand("answers", {
		description: "Alias for /history-all-sessions",
		handler: openAnswersHistory,
	});

	pi.registerCommand("ans", {
		description: "Alias for /history-all-sessions",
		handler: openAnswersHistory,
	});

	pi.registerCommand("history-current-session", {
		description: "Browse answered questions from the current session only (usage: /history-current-session)",
		handler: openCurrentSessionHistory,
	});

	pi.registerCommand("latest-output-auto", {
		description: "Toggle automatic latest-output pager (usage: /latest-output-auto [on|off])",
		handler: async (args, ctx) => {
			const value = args.trim().toLowerCase();
			if (value === "on") autoOpen = true;
			else if (value === "off") autoOpen = false;
			else autoOpen = !autoOpen;

			ctx.ui.setStatus(STATUS_KEY, autoOpen ? ctx.ui.theme.fg("dim", "latest output pager: auto") : undefined);
			ctx.ui.notify(`Latest output pager auto-open ${autoOpen ? "enabled" : "disabled"}`, "info");
		},
	});

	pi.registerShortcut("ctrl+shift+o", {
		description: "Open latest assistant output pager",
		handler: async (ctx) => {
			if (!lastText) {
				ctx.ui.notify("No latest assistant output captured yet; use /latest-output after a response", "warning");
				return;
			}
			const outputText = lastText;
			await showLatestResponsePager(ctx, outputText);
		},
	});

	// NOTE: registered as "ctrl+alt+up" because that's what Option+Cmd+Up
	// actually decodes to in this environment: Ghostty (macos-option-as-alt,
	// legacy CSI encoding, no kitty protocol through tmux) sends CSI 1;7A,
	// which pi-tui parses as modifier bits 2|4 = alt+ctrl. Verified empirically
	// with `cat -v` capture + matchesKey test, 2025-08-19.
	pi.registerShortcut("ctrl+alt+up", {
		description: "Browse current-session answers in the pager, starting from the latest response (press: Option+Cmd+Up)",
		handler: async (ctx) => {
			const pickerChoices = await currentSessionPickerChoices(ctx);
			if (!pickerChoices) return;

			const pages: PagerPage[] = pickerChoices.map((choice) => ({
				title: choice.label,
				getText: () => choice.value,
			}));

			await showPager(ctx, pages, 0);
		},
	});
}
