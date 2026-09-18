# Milestones

Meta-plan: **M0–M1 are shipped today.** From M2 onward, the harness develops itself — each milestone is worked through the conductor + subagents inside nightmare itself. That's the bootstrap test: the tool must be good enough to build its next version.

Definition of done (every milestone): works on a real local model, verified by the acceptance criteria below, no new npm dependencies, everything logged, docs updated.

---

## M0 — Bootstrap ✅ (shipped 2026-02-15)

The absolute minimum: an agentic loop with exactly one tool (bash), promptable from the terminal.

- [x] Agentic loop: model reply → detect ` ```bash ` block → run it → feed `OUTPUT:`/`EXIT` back → repeat until plain text
- [x] Minimal system prompt (~100 tokens) + just-in-time checklists
- [x] Guardrails: iteration cap, command timeout, output cap, identical-command loop detector, empty-response nudge
- [x] OpenAI-compatible client (streaming + JSON fallback)
- [x] Onboarding: `setup` = paste URL (or auto-detect Ollama/LM Studio/llama.cpp/vLLM) → pick model → ping → done
- [x] Persistent sessions (`.nightmare/sessions/`), resume last session on `chat`
- [x] `/compact` manual compaction
- [x] `run` (one-shot), `models`, `status`
- [x] Offline test path: mock OpenAI-compatible server

**Acceptance (met):** with the mock server, `node nightmare.js run "…"` executes a bash tool call, feeds the output back, and ends with a plain-text answer. With a real local model, `setup` + `chat` works end to end.

---

## M1 — Decoupled chat ✅ (shipped 2026-02-15)

The 24/7 face: a daemon you can chat with from anywhere, decoupled from where the app runs.

- [x] Daemon mode: HTTP bridge on 127.0.0.1:8686 (configurable)
- [x] SSE event stream (deltas, tool calls/results, state, errors)
- [x] Chat queue: messages accepted while busy, processed FIFO, serial
- [x] Single-file static UI (`ui/index.html`): chat, tool cards, status bar, new-session/compact buttons
- [x] Optional shared token auth; UI prompts once
- [x] `/health`, `/session`, `/tasks` endpoints
- [x] SSH-tunnel-friendly (plain TCP port, no exotic protocols)

**Acceptance (met):** start the daemon inside a VM; open the UI over `ssh -N -L`; send a message; watch it work. Kill the browser; daemon keeps working.

---

## M2 — Subagents & the conductor

Heavy work leaves the main chat. The conductor delegates; summaries come back.

Scope:
- Task lifecycle hardening: lock file per task (no double-runs), crash-recovery (stuck `running` → re-queueable), task file schema v1
- Conductor prompt v2: the system prompt learns to delegate — "non-trivial work → `task add` + `task run` + report the summary"
- Subagent summary contract enforced (checklists/task.md): WHAT / VERIFY / RISKS / NEXT
- UI: task panel (list, create, status, result)
- Stretch: live subagent output in the UI (poll task session / log tail)

**Acceptance:** you say in chat "add a /ping endpoint to the bridge and test it" → conductor creates a task, runs it, the subagent's summary (with verify evidence) lands back in chat → you verify with curl. The conductor's session stays small.

---

## M3 — Context discipline

The model should stay sharp at turn 50 like at turn 1.

Scope:
- Checklist pack: coding, debug, task (+ review) — trimmed, each ≤ 30 lines
- Auto-compaction tuned per model (`contextWarnChars`, brief quality; verify brief preserves goal + file paths)
- Context budget visible: UI shows current session size vs. threshold; `/status` too
- Memory: `.nightmare/memory.md` (decisions, preferences, gotchas) — conductor appends on request, reads on demand; never in the prompt
- Prompt audit: system prompt + checklists word-for-word review; cut anything the model ignores

**Acceptance:** a 50-turn session with heavy tool use still does what you ask (no context-rot behavior like forgetting the goal or re-reading files it already read), and compaction never drops the active goal.

---

## M4 — Dark factory

Night = free compute. The daemon becomes a factory with a morning report.

Scope:
- Scheduler: 60s tick; idle-mode (work whenever free) + night-window mode (e.g. 23:00–07:00)
- Queue consumer: auto-runs queued tasks in subagents, serial
- Maintenance jobs: configured recurring jobs (test suite + fix + commit; git pull + test; dependency check)
- Digest: nightly rollup of task results + `insights/inbox.md` → `.nightmare/digest/YYYY-MM-DD.md` + chat ping
- Insights: subagents append one-line findings to `insights/inbox.md`
- Pause switch: `touch .nightmare/PAUSE` stops scheduled work, chat stays live
- Heartbeat: scheduler logs a line per tick to `logs/heartbeat.log` (proof of life you can check in the morning)

**Acceptance (the overnight test):** queue 3 tasks at 23:00, go to sleep. At 07:00: all 3 have results, the digest exists, the chat ping is waiting, and the heartbeat log shows continuous ticks. You read ≤ 20 lines and know everything.

---

## M5 — Hardening & self-hosting

The harness reliably builds itself.

Scope:
- `nightmare doctor`: config validity, endpoint reachability, model ping, disk space, session integrity, log size
- Crash recovery: daemon restart mid-turn → session consistent, queued messages intact, stuck tasks re-queued
- Model profiles: per-model presets (context window, compaction threshold, temperature, max_tokens, patience) — e.g. `qwen3-coder-32k` vs `llama-8k`
- Structured log rotation (agent.log caps at N MB)
- UI: session history browser, log viewer
- Test suite: loop, protocol, bridge, scheduler — runnable locally, no cloud CI needed
- Dev workflow: "develop nightmare inside nightmare" — dev checklist, commit-per-task on main, `git` discipline in checklists

**Acceptance:** `doctor` green on a fresh machine; kill -9 the daemon mid-task and restart → nothing lost; the test suite passes on the model currently configured; M5 was itself built via M2–M4 workflows.

---

## M6 — Extensions (pick, don't plan)

- Multiple endpoint profiles + routing (small model for triage/classification, big model for coding)
- Native tool-call mode as a per-model option (keep the text protocol as default)
- Git workflows: branch-per-task, PR-style review flow (a reviewer subagent)
- Checklist packs as shareable "skills" folders
- Mobile-friendly UI polish; session export (markdown)
- Single-binary distribution (Node SEA) for "copy one file onto a machine"
- Parallel subagents across multiple model servers (only if you actually run >1)

---

## Effort & ordering

| Milestone | Size | Why this order |
|---|---|---|
| M0 ✅ | done | the primitive everything else stands on |
| M1 ✅ | done | the 24/7 face — you need it to use the tool daily |
| M2 | S–M | unlocks "work gets done without me holding the keyboard" |
| M3 | M | makes M2's long subagent sessions actually reliable |
| M4 | M | the payoff: the dark factory |
| M5 | M | trust: it can build itself without babysitting |
| M6 | ∞ | only what you actually want |
