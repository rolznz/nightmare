# Open Questions & Suggestions

Feedback welcome — reply with the question number and your call (e.g. "Q3: tunnel by default", "P5: agreed"). Where I've marked a **default**, that's what I'll build if you stay silent.

## A. Runtime & topology

1. **Runtime: Node.js, zero dependencies — keep?** Chosen for sovereignty (no supply chain), auditability, and because the model can safely edit its own harness. Python and Rust are fine alternatives; Rust would hurt self-development. **Default: keep Node.**
2. **Where does the app live, and where does the model live?** Same box, or app in a VM/container while the model server is elsewhere (LAN)? This drives docs, defaults, and whether "containment = VM" is the recommended setup. **Default: documented as "app in a VM, chat from anywhere, model can be the same or on the LAN."**
3. **Network exposure: loopback-only + SSH tunnel, or bind 0.0.0.0 with a token?** The token is already implemented. A bound port on a home LAN is fine with a strong token; a VM makes loopback enough. **Default: loopback + tunnel docs; token available.**
4. **One daemon per project directory, or a global daemon with a project switcher?** Per-project keeps state cleanly separated (`.nightmare/` is per-cwd today). **Default: one daemon = one project box; run multiple daemons if needed.**
5. **Name check 🙂** "nightmare" for the dark factory. State dir is `.nightmare/`. Any veto before it's carved in stone? **Default: keep it.**

## B. Models

6. **Which local models/servers do you actually run?** (Ollama? LM Studio? llama.cpp? Which family/size/context window — Qwen3-coder 32k, Llama, Gemma, DeepSeek?) This tunes defaults: compaction threshold, temperature, `max_tokens`, and how much hand-holding the protocol needs. **Default: tuned for 32k-context coding models, degrades to 16k.**
7. **Single model for everything, or routing later** (small model for triage/classification/insight-lines, big model for coding)? Routing is on the M6 list but I'd like your appetite. **Default: single model until M6.**
8. **Text protocol forever, or add native tool-call mode per model?** Text fences are robust but slightly slower than native calls on strong models. **Default: text protocol stays the foundation; native mode as an M6 option.**

## C. Autonomy & safety

9. **Hands-off bash, or guardrails on dangerous commands?** It runs inside your chosen containment, but should the loop still confirm on patterns like `rm -rf`, `git push`, or outbound network? **Default: fully hands-off inside containment + full command logging; no confirmation prompts (they'd break the 24/7 story).**
10. **Git policy for subagent work:** commit-per-task on main? feature branches? no git by default? **Default: commit per task on main with `task id` in the message; branches only when you ask.**
11. **Insight surfacing: what's enough?** Options: digest file only / chat ping only / both / also a terminal notification. **Default: digest file + chat ping (both).**
12. **Night window or always-on?** Idle-queue (work whenever nothing else is running) is more efficient; a fixed window (e.g. 23:00–07:00) gives you a clean "it works at night" boundary. **Default: idle-queue now, night window as a config option.**
13. **Telemetry: none, ever?** (Stated in the tenets — confirming.) **Default: none.**

## D. Product & interface

14. **UI scope for v1:** chat + tasks + status bar is all that's there. Want a logs view or session browser earlier than M5? **Default: no, keep the UI tiny.**
15. **Language for prompts/checklists/UI:** English throughout? **Default: yes.**
16. **Distribution later:** single-folder + Node (today), or a single binary (Node SEA) so it's "copy one file onto any machine"? **Default: folder now, binary at M5/M6 if it matters.**
17. **License / open source:** private until it's solid, then open? **Default: private for now.**

## E. Suggestions (my proposals — accept, reject, or riff)

- **P1 — Text protocol as the default, native tools as an option.** Weakest local model that still codes is the target; native tool calls are the thing small models break most.
- **P2 — Subagents are re-entry, not a new runtime.** `task run` is just `run` with a fresh session. No SDK, no second process model. Everything about a subagent is inspectable as a file.
- **P3 — The conductor prompt stays ≤ 120 tokens; all policy lives in files.** The moment system-prompt policy grows, we've lost the context budget. Checklist files are the policy layer.
- **P4 — Task files are the unit of work and the audit trail.** JSON, human-readable, one file per task, status in the file. The factory's entire output is reconstructable from `.nightmare/tasks/`.
- **P5 — The digest is the morning contract.** One file, ≤ 30 lines, always the same shape: done / failed / insights / questions-for-you. Everything else is noise.
- **P6 — Zero npm dependencies is a policy, not an accident.** It's what makes the app sovereign and self-editable. If M6 ever needs a dep, it gets a line in this doc with a reason.
- **P7 — `nightmare doctor` by M5.** One command answers "is my factory healthy?": config, endpoint, model ping, disk, session integrity, log size.
- **P8 — A `constitution.md` you write.** Your values as agent policy: "never push to remote", "never touch files outside this repo", "ask before spending > N minutes on one task". Read at session start (or on demand). Cheaper than baking it into the prompt.
- **P9 — Containment first: the recommended install is a disposable VM.** The whole "sovereign" story gets stronger if the default recommendation is "run nightmare in a throwaway VM and tunnel in" — blast radius zero, teardown = delete the VM.
- **P10 — `PAUSE` as a file, not a command.** `touch .nightmare/PAUSE` from any terminal stops the factory; chat stays alive. One file beats one config flag beats one API call.
- **P11 — A dev-checklist for building nightmare inside nightmare.** `checklists/dev-nightmare.md`: read ARCHITECTURE + MILESTONES first, one milestone task = one commit, run the mock test suite after every change, update the decisions log. This is what makes "all development happens inside the harness" actually work instead of drifting.
