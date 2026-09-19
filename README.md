# nightmare

A minimal, sovereign agentic harness for **local AI**. One chat interface, 24/7, that does the work in subagents on your own hardware — the *dark factory*: it builds overnight on free local tokens, files insights, and hands you a morning digest while you focus on ideas and features.

- **Minimal prompt, maximal leverage** — ~100-token system prompt; checklists read just-in-time; subagents get fresh contexts; sessions auto-compact.
- **One tool: bash.** Auditable, universal, sandboxable.
- **Model-agnostic text protocol** — works on any OpenAI-compatible endpoint, even weak models that mangle native tool calls.
- **Files as memory** — sessions, tasks, logs, insights: plain files in `.nightmare/`. No database, no lock-in.
- **Decoupled UI** — static web page over HTTP/SSE; run the app in a VM, chat from anywhere over an SSH tunnel.
- **No cloud. No telemetry. No npm dependencies.** One file, zero packages.

## Requirements

- Node.js ≥ 18
- Any OpenAI-compatible local model server: Ollama, LM Studio, llama.cpp, vLLM, SGLang…

## Quickstart

```bash
node nightmare.js setup     # paste your OpenAI-compatible URL → pick a model → done
node nightmare.js chat      # develop in the terminal (resumes your last session)
node nightmare.js daemon    # 24/7 mode → open http://127.0.0.1:8686
```

Running the app in a VM / sandbox? Tunnel it and chat from anywhere:

```bash
ssh -N -L 8686:127.0.0.1:8686 user@vm
# then open http://127.0.0.1:8686 in any browser
```

## Try it with no model (offline test)

```bash
node test/mock/server.js 9999 &          # mock OpenAI-compatible server
node nightmare.js setup http://127.0.0.1:9999/v1 --model mock-coder
node nightmare.js run "verify the endpoint works"
node nightmare.js task add "write a hello world script" && node nightmare.js task list
```

## Commands

| Command | What it does |
|---|---|
| `setup [url] [--model <id>]` | Onboarding: endpoint → pick model → ping → config saved |
| `chat` | Interactive chat; `/new /status /model <id> /compact /tasks /exit` |
| `run "<prompt>" [--json]` | One-shot agent run (ephemeral session) |
| `task add "<prompt>" [--title t]` | Queue a subagent task |
| `task list` / `task run <id>` | Inspect / run a task (fresh context, summary back) |
| `daemon [--port N] [--host H]` | 24/7 bridge + web UI |
| `models` / `status` | Endpoint models / config+session+task overview |

## Repository

```
nightmare.js          the whole app (zero dependencies)
ui/index.html         the decoupled web UI (single file, no build)
checklists/           just-in-time agent knowledge (coding, debug, task)
docs/
  ARCHITECTURE.md     design tenets, topology & loop diagrams, protocol, context budget
  MILESTONES.md       M0–M6 plan (M0–M1 shipped)
  QUESTIONS.md        open questions + suggestions — your feedback goes here
  GITHUB.md           how nightmare will build itself through a public github repository
test/mock/server.js   offline mock OpenAI-compatible server
.nightmare/           runtime state (gitignored)
```

## The bootstrap idea

From M0 onward, **all development of nightmare happens inside nightmare.** Point it at this repo, open `chat`, and give it a milestone from `docs/MILESTONES.md`. Read the architecture before asking for changes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

The first commit was made with PI agent (Qwen3.8 27b).

Following commits have been made with nightmare (Qwen3.8 27b).