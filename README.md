# MACE — Multi-Agent Consensus Engine

A structured AI debate engine that forces distinct cognitive frameworks to cross-examine each other and arrive at a battle-tested decision.

Instead of asking one AI for an answer, MACE spins up 3–4 adversarial personas (The Auditor, The Architect, The Pragmatist, etc.), runs them through multiple rounds of structured debate, and synthesizes their conflict into a final recommendation with a full decision trail.

```bash
node mace.mjs "Should we migrate our REST API to GraphQL?"
```

---

## How It Works

```
Topic → [Prior Context] → [Clarifying Questions] → Brief → Round 1 (Divergence) → Round N (Cross-Examination) → Synthesis
```

1. **Phase 0 — Context Gathering**: If a prior debate is linked, its conclusions are loaded first. Then MACE asks 3–5 clarifying questions to tighten the brief. Press Enter to skip any.
2. **Phase 1 — Intake**: Claude generates a `brief.json` with a problem statement, constraints, success criteria, and selects the most relevant frameworks and debate parameters for your topic.
3. **Phase 2 — Debate Loop**:
   - **Round 1 (Divergence)**: All frameworks analyze in parallel and stake out independent positions.
   - **Rounds 2–N (Cross-Examination)**: Each framework attacks the weakest assumptions in its peers' logic.
   - After each round, a Moderator (Claude) assesses consensus. ≥ threshold → done. < threshold → next round.
   - If max rounds are hit without consensus, frameworks are forced to propose a hybrid compromise.
4. **Phase 3 — Synthesis**: Final report with Executive Summary, Decision Tree, The Graveyard (discarded ideas), Sentiment Timeline, and Final Recommendation.

All output is saved to `debates/{id}/` and the web viewer is updated automatically.

---

## Prerequisites

- **Node.js** v18+
- **Claude CLI** — the engine calls `claude -p "..."` to invoke Claude. Install and authenticate it first:
  ```bash
  npm install -g @anthropic-ai/claude-code
  claude login
  ```

> The engine also supports `gemini` and `codex` CLIs as alternative providers. Assign them per-framework in `config/frameworks.json`. Any unknown provider falls back to a mock response so you can test the flow without all CLIs installed.

---

## Quick Start

```bash
# Clone the repo
git clone https://github.com/your-username/mace.git
cd mace

# Run a debate
node mace.mjs "Should we rewrite our Node.js monolith in Go?"
```

The engine will:
1. Ask a few clarifying questions (press Enter to skip)
2. Pick the best debate panel and parameters for your topic
3. Run 2–N rounds of structured cross-examination
4. Write a synthesis report to `debates/{id}/synthesis.md`

To view results in the web UI:
```bash
npx serve .
# Open http://localhost:3000/viewer/
```

---

## CLI Reference

```bash
# Start a new debate
node mace.mjs "Your topic here"

# Resume a debate that failed or was interrupted
node mace.mjs --resume <debate-id>

# Start a new debate informed by conclusions from a prior one
node mace.mjs --followon <debate-id> "Your follow-on topic"
```

### `--resume`

If a debate times out, crashes, or you kill it mid-run, you can pick up exactly where it left off:

```bash
node mace.mjs --resume deb-1234567890
```

MACE will:
- Reload the brief, panel, and all round files written before the failure
- Skip any framework calls whose output files already exist (no re-running work that succeeded)
- Re-run only the frameworks that didn't finish in a partial round
- Re-assess moderator consensus if it wasn't saved before the crash
- Continue through remaining rounds and synthesis

The debate ID is printed at startup. If a timeout kills an individual model call, it is recorded as an error response and the rest of the round continues — only a full process crash or Ctrl-C requires a resume.

### `--followon`

Build a chain of related debates where each one has full context from the prior decision:

```bash
# Original debate
node mace.mjs "Should we adopt a monorepo?"
# → deb-1111111111

# Follow-on: assumes the monorepo decision was made
node mace.mjs --followon deb-1111111111 "How should we structure CI/CD in the monorepo?"
# → deb-2222222222

# Follow-on of the follow-on
node mace.mjs --followon deb-2222222222 "Which CI platform fits our new pipeline design?"
```

What gets injected from the prior debate:
- The prior topic and problem statement
- The full synthesis (executive summary, decision tree, graveyard, recommendation)

This context is prepended before Phase 0, so clarifying questions, the intake brief, and every framework's Round 1 analysis are all already informed by what was previously decided and what was ruled out.

The `prior_debate_id` is stored in `brief.json` and `index.json` for lineage tracking.

---

## Framework Catalog

MACE selects 3–4 frameworks automatically based on your topic. The intake coordinator picks the panel and explains its reasoning. You can also hardcode them in `config/frameworks.json`.

| Framework | Category | Focus |
|---|---|---|
| **The Auditor** | Universal | Falsification, edge cases, failure modes, Black Swan events |
| **The Devil's Advocate** | Universal | Anti-consensus, exposes groupthink, challenges every assumption |
| **The Architect** | Technical | Long-term system design, scalability, clean boundaries |
| **The Performance Engineer** | Technical | Speed, latency, resource usage, throughput |
| **The Security Engineer** | Technical | Threat modeling, attack surfaces, defense-in-depth |
| **The Product Lead** | Strategic | Developer experience, time-to-market, ROI |
| **The Strategist** | Strategic | Competitive positioning, second-order effects, 3-year horizon |
| **The Operator** | Strategic | Operational burden, on-call, reliability, team capacity |
| **The Therapist** | Personal | Emotional needs, underlying motivations, wellbeing |
| **The Pragmatist** | Personal | Realistic constraints, energy, what will actually get done |
| **The Inner Critic** | Personal | Rationalizations, self-deception, avoidance patterns |
| **The Budget Hawk** | Financial | Total cost of ownership, hidden costs, opportunity cost |
| **The Future Self** | Financial | Regret minimization, long-term life fit, depreciation |
| **The Minimalist** | Financial | Challenges acquisition, advocates doing without |
| **The Ethicist** | Ethical | Moral implications, fairness, values alignment |
| **The Futurist** | Creative | 10-year horizon, disruption, exponential change |

---

## Output Structure

Each debate run produces:

```
debates/{debateId}/
  brief.json          # Problem statement, constraints, selected frameworks, enriched context
  state.json          # Rounds history, consensus level, confidence per framework (written incrementally)
  synthesis.md        # Final report: summary, decision tree, graveyard, recommendation
  debate_data.json    # All data embedded (used by the web viewer)
  rounds/
    r1_{framework}.md       # Each framework's Round 1 position
    r1_compiled.md          # All Round 1 positions combined
    r2_{framework}.md       # Cross-examination responses
    r2_compiled.md
    rN_forced_{fw}.md       # Forced compromise (if deadlock)
    rN_forced_compiled.md

debates/index.json    # Master list consumed by the viewer sidebar
```

`state.json` is written after every round (not just at the end), which is what makes `--resume` possible. `brief.json` stores the enriched context (topic + clarifying Q&A answers + prior debate context) so it's available on resume.

---

## Configuration

### Engine defaults (`mace.mjs`)

```js
const DEFAULT_MAX_ROUNDS = 3;           // Maximum cross-examination rounds before forcing compromise
const DEFAULT_CONSENSUS_THRESHOLD = 70; // % agreement required to conclude the debate
const MODEL_TIMEOUT_MS = 5 * 60 * 1000; // Per-model timeout (5 minutes)
```

The intake coordinator can override `max_rounds` (2–5) and `consensus_threshold` (50–85%) dynamically based on the complexity of the topic. Its rationale is logged at startup.

### Adding a Framework (`config/frameworks.json`)

```json
"my_framework": {
  "name": "The Skeptic",
  "category": "universal",
  "description": "Short description shown to the intake coordinator when selecting the panel.",
  "provider": "claude",
  "mandate": "Your full system prompt / cognitive constraint goes here."
}
```

Set `provider` to `claude`, `gemini`, `codex`, or any other value to trigger a mock response (useful for testing the flow).

### Assigning different providers per framework

Each framework can use a different AI CLI. The intake phase and moderator always use Claude.

```json
"architect": {
  "provider": "gemini"
},
"auditor": {
  "provider": "claude"
}
```

---

## Web Viewer

The viewer is a self-contained SPA at `viewer/index.html`. It reads from `debates/index.json` and loads individual `debate_data.json` files on demand — no server-side code required.

```bash
npx serve .
# Open http://localhost:3000/viewer/
```

Features:
- Sidebar listing all past debates
- Tabs for the brief, each round, sentiment chart, and synthesis
- Canvas-based confidence timeline per framework across all rounds
- Markdown-rendered synthesis with Graveyard section highlighted

---

## License

MIT
