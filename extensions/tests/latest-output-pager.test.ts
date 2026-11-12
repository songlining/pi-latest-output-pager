import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import latestOutputPager, { LatestOutputPager, resolveViKey } from "../latest-output-pager";

function makePager(paragraphs = 200) {
	const text = Array.from({ length: paragraphs }, (_, i) => `line ${i}`).join("\n\n");
	const pager = new LatestOutputPager(
		() => 30,
		[{ title: "test", getText: () => text }],
		0,
		{ fg: (_style: string, value: string) => value } as unknown as ConstructorParameters<typeof LatestOutputPager>[3],
		() => {},
	);
	pager.render(120);
	return pager as unknown as {
		handleInput(data: string): void;
		render(width: number): string[];
		scroll: number;
		maxScroll(): number;
	};
}

test("count prefix accumulates across digits, then drives j/k", () => {
	let pending = "";
	for (const digit of "12") {
		const result = resolveViKey(digit, pending);
		expect(result).toEqual({ pending: expect.any(String) });
		pending = (result as { pending: string }).pending;
	}
	expect(pending).toBe("12");
	expect(resolveViKey("j", pending)).toEqual({ kind: "scroll", unit: "line", dir: 1, count: 12 });
	expect(resolveViKey("k", "5")).toEqual({ kind: "scroll", unit: "line", dir: -1, count: 5 });
});

test("bare 0 is a no-op; 0 after a count extends it", () => {
	expect(resolveViKey("0", "")).toBeUndefined();
	expect(resolveViKey("0", "1")).toEqual({ pending: "10" });
});

test("paging and goto keys", () => {
	expect(resolveViKey(" ", "")).toEqual({ kind: "scroll", unit: "full", dir: 1, count: 1 });
	expect(resolveViKey("b", "2")).toEqual({ kind: "scroll", unit: "full", dir: -1, count: 2 });
	expect(resolveViKey("g", "")).toEqual({ kind: "goto", line: "top" });
	expect(resolveViKey("G", "")).toEqual({ kind: "goto", line: "bottom" });
	expect(resolveViKey("G", "1")).toEqual({ kind: "goto", line: 1 });
	expect(resolveViKey("G", "42")).toEqual({ kind: "goto", line: 42 });
});

test("unrelated keys leave the count prefix for the caller to clear", () => {
	expect(resolveViKey("q", "5")).toBeUndefined();
	expect(resolveViKey("c", "5")).toBeUndefined();
});

test("pager scrolls vi-style: counts, g/G, ctrl+u/d, page keys", () => {
	const pager = makePager();
	// The TUI renders between keypresses, which is what repopulates the cached
	// line count that maxScroll() needs, so mirror that here.
	const press = (key: string) => {
		pager.render(120);
		pager.handleInput(key);
		return pager.scroll;
	};

	const max = pager.maxScroll();
	expect(max).toBeGreaterThan(50);

	expect(press("G")).toBe(max);
	expect(press("g")).toBe(0);

	press("5");
	expect(press("j")).toBe(5);
	expect(press("k")).toBe(4); // the 5 was consumed by the previous key

	press("3");
	expect(press("G")).toBe(2); // 3G = line 3
	press("1");
	expect(press("G")).toBe(0); // 1G = top

	const half = press("\x04"); // ctrl+d half page down
	expect(half).toBeGreaterThan(0);
	expect(press("\x15")).toBe(0); // ctrl+u half page up

	const full = press(" ");
	expect(full).toBeGreaterThan(half);
	expect(press("b")).toBe(0);

	// dedicated keys and their shift/ctrl variants page the same way
	for (const key of ["\x1b[6~", "\x1b[6$", "\x1b[6^", "\x06"]) {
		press("g");
		expect(press(key)).toBe(full);
	}
	for (const key of ["\x1b[5~", "\x1b[5$", "\x1b[5^", "\x02"]) {
		press("g");
		press(" ");
		expect(press(key)).toBe(0);
	}

	expect(press("\x1b[F")).toBe(max); // end
	expect(press("\x1b[H")).toBe(0); // home
});

test("live insert: the new answer becomes page 1 and the page being read is renumbered in place", () => {
	const theme = { fg: (_style: string, value: string) => value } as unknown as ConstructorParameters<typeof LatestOutputPager>[3];
	const pages = [
		{ title: "01. first", getText: () => "first answer" },
		{ title: "02. second", getText: () => "second answer" },
	];
	const pager = new LatestOutputPager(() => 30, pages, 1, theme, () => {});

	const before = pager.render(120);
	expect(before[1]).toContain("02. second");
	expect(before[1]).toContain("[2/2]");

	pager.prependPage({ title: "01. newest", getText: () => "newest answer" });

	const after = pager.render(120);
	expect(after[1]).toContain("03. second"); // same content, position advanced
	expect(after[1]).toContain("[3/3]");
	expect(after.join("\n")).toContain("second answer");
	expect(after.join("\n")).not.toContain("newest answer");
});

test("a opens the follow-up input; Enter sends it and the page stays put", () => {
	const theme = { fg: (_style: string, value: string) => value } as unknown as ConstructorParameters<typeof LatestOutputPager>[3];
	const sent: string[] = [];
	const pager = new LatestOutputPager(
		() => 20,
		[
			{ title: "01. first", getText: () => "first answer" },
			{ title: "02. second", getText: () => "second answer" },
		],
		1,
		theme,
		() => {},
		async (question) => {
			sent.push(question);
		},
	);

	expect(pager.render(120).join("\n")).not.toContain("Ask a follow-up");
	pager.handleInput("a");
	expect(pager.render(120).join("\n")).toContain("Ask a follow-up");

	for (const char of "why?") pager.handleInput(char);
	expect(pager.render(120).join("\n")).toContain("why?");

	pager.handleInput("\r"); // Enter
	expect(sent).toEqual(["why?"]);

	const after = pager.render(120);
	expect(after.join("\n")).not.toContain("Ask a follow-up");
	expect(after[1]).toContain("02. second"); // still reading the same page
	expect(after.join("\n")).toContain("Question sent");
});

test("escape cancels the follow-up input without sending", () => {
	const theme = { fg: (_style: string, value: string) => value } as unknown as ConstructorParameters<typeof LatestOutputPager>[3];
	const sent: string[] = [];
	const pager = new LatestOutputPager(
		() => 20,
		[{ title: "01. first", getText: () => "first answer" }],
		0,
		theme,
		() => {},
		async (question) => {
			sent.push(question);
		},
	);

	pager.handleInput("a");
	const focused = (pager as unknown as { askInput: { focused: boolean } }).askInput;
	expect(focused.focused).toBe(true); // drives the hardware cursor / IME anchor
	pager.handleInput("d");
	pager.handleInput("\x1b"); // Escape
	expect(focused.focused).toBe(false);
	expect(pager.render(120).join("\n")).not.toContain("Ask a follow-up");
	pager.handleInput("\r"); // Enter on a closed input must not submit anything
	expect(sent).toEqual([]);
});

test("after the follow-up answer is inserted, it is one page left", () => {
	const theme = { fg: (_style: string, value: string) => value } as unknown as ConstructorParameters<typeof LatestOutputPager>[3];
	const pager = new LatestOutputPager(
		() => 20,
		[{ title: "01. first", getText: () => "first answer" }],
		0,
		theme,
		() => {},
		async () => {},
	);

	pager.render(120);
	pager.prependPage({ title: "01. follow-up", getText: () => "follow-up answer" });
	expect(pager.render(120).join("\n")).not.toContain("follow-up answer");

	pager.handleInput("\x1b[D"); // left arrow
	expect(pager.render(120).join("\n")).toContain("follow-up answer");
});

test("a send failure is reported and repaints", () => {
	const theme = { fg: (_style: string, value: string) => value } as unknown as ConstructorParameters<typeof LatestOutputPager>[3];
	let repainted = 0;
	const pager = new LatestOutputPager(
		() => 20,
		[{ title: "01. first", getText: () => "first answer" }],
		0,
		theme,
		() => {},
		async () => {
			throw new Error("no model is selected, so nothing can answer");
		},
		() => {
			repainted++;
		},
	);

	pager.handleInput("a");
	pager.handleInput("x");
	pager.handleInput("\r");
	return Promise.resolve().then(() => {
		expect(repainted).toBe(1);
		expect(pager.render(120).join("\n")).toContain("Send failed: no model is selected");
	});
});

test("a works on a page that failed to load", () => {
	const theme = { fg: (_style: string, value: string) => value } as unknown as ConstructorParameters<typeof LatestOutputPager>[3];
	const sent: string[] = [];
	const pager = new LatestOutputPager(
		() => 20,
		[
			{
				title: "01. broken",
				getText: () => {
					throw new Error("boom");
				},
			},
		],
		0,
		theme,
		() => {},
		async (question) => {
			sent.push(question);
		},
	);

	expect(pager.render(120).join("\n")).toContain("Could not load conversation");
	pager.handleInput("a");
	expect(pager.render(120).join("\n")).toContain("Ask a follow-up");
	pager.handleInput("x");
	pager.handleInput("\r");
	expect(sent).toEqual(["x"]);
});

// End-to-end wiring: the extension factory -> shortcut -> pager -> pi.sendUserMessage.
function fakePi() {
	const shortcuts = new Map<string, (ctx: unknown) => unknown>();
	const events = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const sent: Array<{ text: string; options: unknown }> = [];
	return {
		pi: {
			on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => events.set(name, handler),
			registerCommand: () => {},
			registerShortcut: (key: string, options: { handler: (ctx: unknown) => unknown }) => shortcuts.set(key, options.handler),
			sendUserMessage: (text: string, options?: unknown) => {
				sent.push({ text, options });
			},
		},
		shortcuts,
		events,
		sent,
	};
}

test("wiring: the typed question reaches pi.sendUserMessage, idle or streaming", async () => {
	const { pi, shortcuts, events, sent } = fakePi();
	latestOutputPager(pi as unknown as ExtensionAPI);

	// Short output, so agent_end records the latest text without auto-opening.
	await events.get("agent_end")!(
		{ messages: [{ role: "assistant", content: "hello" }] },
		{ sessionManager: { getBranch: () => [] }, ui: { notify: () => {} }, isIdle: () => true, mode: "tui", cwd: "/tmp" },
	);

	const open = async (ctx: Record<string, unknown>) => {
		let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
		const fullCtx = {
			mode: "tui",
			cwd: "/tmp",
			...ctx,
			ui: {
				notify: () => {},
				setStatus: () => {},
				setWidget: () => {},
				custom: async (factory: (...args: unknown[]) => unknown) => {
					component = factory(
						{ terminal: { rows: 20 }, requestRender: () => {} },
						{ fg: (_style: string, value: string) => value },
						{},
						() => {},
					) as typeof component;
					return undefined;
				},
			},
			sessionManager: { getSessionFile: () => undefined, getBranch: () => [] },
		};
		await shortcuts.get("ctrl+shift+o")!(fullCtx);
		return component!;
	};

	const idlePager = await open({ model: { id: "m" }, isIdle: () => true });
	idlePager.render(120);
	idlePager.handleInput("a");
	idlePager.handleInput("w");
	idlePager.handleInput("\r");
	expect(sent).toEqual([{ text: "w", options: undefined }]);

	const streamingPager = await open({ model: { id: "m" }, isIdle: () => false });
	streamingPager.render(120);
	streamingPager.handleInput("a");
	streamingPager.handleInput("y");
	streamingPager.handleInput("\r");
	expect(sent[1]).toEqual({ text: "y", options: { deliverAs: "followUp" } });

	const modellessPager = await open({ model: undefined, isIdle: () => true });
	modellessPager.render(120);
	modellessPager.handleInput("a");
	modellessPager.handleInput("z");
	modellessPager.handleInput("\r");
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(sent).toHaveLength(2); // rejected before reaching the agent
	expect(modellessPager.render(120).join("\n")).toContain("Send failed: no model is selected");
});

test("the terminal sequences the pager binds actually decode", () => {
	expect(matchesKey(" ", Key.space)).toBe(true);
	expect(matchesKey("\x1b[6~", Key.pageDown)).toBe(true);
	expect(matchesKey("\x1b[5~", Key.pageUp)).toBe(true);
	expect(matchesKey("\x1b[6$", Key.shift("pageDown"))).toBe(true);
	expect(matchesKey("\x1b[5$", Key.shift("pageUp"))).toBe(true);
	expect(matchesKey("\x1b[6^", Key.ctrl("pageDown"))).toBe(true);
	expect(matchesKey("\x1b[5^", Key.ctrl("pageUp"))).toBe(true);
	expect(matchesKey("\x06", Key.ctrl("f"))).toBe(true);
	expect(matchesKey("\x02", Key.ctrl("b"))).toBe(true);
	expect(matchesKey("\x15", Key.ctrl("u"))).toBe(true);
	expect(matchesKey("\x04", Key.ctrl("d"))).toBe(true);
});
