# pi-latest-output-pager

A [pi](https://pi.dev) extension that opens assistant output in a `less`-like pager, so long
answers can be read, searched and scrolled without the terminal's scrollback, and browsed
back through the session's history with the arrow keys.

It also lets you ask a follow-up question from inside the pager, without quitting the page
you are reading.

```
┌────────────────────────────────────────────────────────────────┐
│ 03. Why does the Terraform plan show a diff on the tags? [3/7] │
│ ← prev conversation • -> next conversation • a ask • q quit     │
├────────────────────────────────────────────────────────────────┤
│ The plan shows a diff because ...                              │
└────────────────────────────────────────────────────────────────┘
```

## Install

```bash
pi install git:github.com/songlining/pi-latest-output-pager
```

Pin a release with `@v0.1.1` on the end, or install into a single project with `-l`.

## Commands

| Command | What it does |
| --- | --- |
| `/latest-output` | Open the latest assistant output in the pager, with the rest of this session's questions and answers as pages |
| `/latest-output-auto [on\|off]` | Toggle auto-opening the pager after a long reply (default: on) |
| `/history-current-session` | Pick one of this session's questions, read its answer in the pager |
| `/history-all-sessions [--all] [--sessions]` | Cross-session: pick a question from any session in this project (`--all` = every project, `--sessions` = pick a conversation instead of a question) |
| `/answers`, `/ans` | Aliases for `/history-all-sessions` |

`/history-all-sessions` is deliberately project-wide, not session-wide; the session-scoped
variant is `/history-current-session`.

## Shortcuts

| Key | Action |
| --- | --- |
| `ctrl+shift+o` | Open the latest assistant output pager |
| `ctrl+alt+up` | Open this session's answers in the pager, starting at the latest response |

The second one is registered as `ctrl+alt+up` on purpose. Through Ghostty
(`macos-option-as-alt`) plus tmux there is no kitty keyboard protocol, so Option+Cmd+Up
arrives as the legacy `CSI 1;7A`, whose modifier bits decode as alt+ctrl — that is the
sequence pi-tui actually matches. With a kitty-protocol terminal and no tmux in the way,
rebind it to `alt+super+up` if you prefer.

## Keys inside the pager

| Key | Action |
| --- | --- |
| `←` / `→` | Previous / next answer (page 0 is always the newest) |
| `Space`, `PgDn`, `ctrl+f` | Page down · `b`, `PgUp`, `ctrl+b` page up |
| `ctrl+d` / `ctrl+u` | Half page down / up |
| `j` / `k` | One line down / up |
| `g`, `gg`, `1G` | Top · `G` bottom · `40G` line 40 |
| `3j`, `2ctrl+d`, `3Space` | Count prefixes work on `j k Space b ctrl+d ctrl+u` |
| `/` `?` `n` `N` | Search forward / backward, next / previous match |
| `a` | Ask a follow-up question without leaving the pager |
| `c` | Copy the current page to the clipboard |
| `q`, `Esc`, `ctrl+c` | Quit |

Shift and ctrl variants of `PgUp`/`PgDn` are accepted too, because Mac keyboards send
`Fn+arrow` for them.

## Follow-up questions from inside the pager

Press `a` while reading:

```
│ Ask a follow-up — Enter sends it without leaving the pager · Esc cancel  │
│ > why does that only happen on the second apply?_                       │
```

`Enter` sends it as an ordinary user message and the pager stays exactly where it is.
The question is queued as a follow-up if a turn is still running. When the answer
finishes it is inserted as the newest page, the page you were reading keeps its content
and its number advances by one, and `←` shows the new answer — the status line says
"New answer added — press ← to read it".

Notes:

- The input is a single-line row inside the pager (paste is supported and flattened to one
  line). It is not a second floating overlay, so there is no focus fight with the pager.
- Streaming output is not shown inside the pager; the answer appears when the turn ends.
- `pi.sendUserMessage` is fire-and-forget, so a rejected send cannot be observed by an
  extension. The one case that can be checked up front (no model selected) is reported in
  the help line as "Send failed: ...", and any other failure surfaces in pi's own
  extension error channel behind the pager.

## Auto-open

After a reply that is taller than the terminal, the pager opens by itself. It never replaces
an overlay you already have on screen: if a **pager** is open when a turn finishes, the new
answer is added to it as the newest page instead (press `←`). If a history **picker** is
the open overlay, the answer is only recorded for the next `/latest-output` — the picker
stays as it was. Turn it off with `/latest-output-auto off`; the status line shows
`latest output pager: auto` while it is on.

If [pi-codex-goal](https://www.npmjs.com/package/pi-codex-goal) has an active goal, the
auto-open is skipped so a goal continuation is never left waiting on a modal.

## Development

```bash
bun install
bun test          # component + end-to-end wiring tests
bun run typecheck
```

The tests live in `extensions/tests/` on purpose: pi auto-loads every top-level `*.ts` in
an `extensions/` directory, so a top-level `latest-output-pager.test.ts` would be loaded as
an extension and break startup on the `bun:test` import. Subdirectories are only loaded
when they contain an `index.ts` or a package manifest.

Debug aid: `touch /tmp/latest-output-pager.log` and the extension appends auto-open and
live-insert decisions to it; delete the file to go quiet again.

## License

MIT
