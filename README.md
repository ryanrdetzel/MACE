# MACE — Multi-Agent Consensus Engine

A structured AI debate engine that forces distinct cognitive frameworks to cross-examine each other and arrive at a battle-tested decision.

Instead of asking one AI for an answer, MACE spins up 3–4 adversarial personas (The Auditor, The Architect, The Pragmatist, etc.), runs them through multiple rounds of structured debate, and synthesizes their conflict into a final recommendation with a full decision trail.

```
node mace.mjs "Should we migrate our REST API to GraphQL?"
```

---

## How It Works

```
Topic → [Clarifying Questions] → Brief → Round 1 (Divergence) → Round N (Cross-Examination) → Synthesis
```

1. **Phase 0 — Context Gathering**: MACE asks you 3–5 clarifying questions to tighten the brief. Press Enter to skip any.
2. **Phase 1 — Intake**: Claude generates a `brief.json` with a problem statement, constraints, success criteria, and selects the most relevant frameworks for your topic.
3. **Phase 2 — Debate Loop**:
   - **Round 1 (Divergence)**: All frameworks analyze in parallel and stake out independent positions.
   - **Rounds 2–4 (Cross-Examination)**: Each framework attacks the weakest assumptions in its peers' logic.
   - After each cross-examination round, a Moderator (Claude) assesses consensus. ≥ 80% → done. < 80% → next round.
   - If max rounds are hit without consensus, frameworks are forced to propose a hybrid compromise.
4. **Phase 3 — Synthesis**: Final report with Executive Summary, Decision Tree, The Graveyard (discarded ideas), Sentiment Timeline, and Final Recommendation.

All output is saved to `debates/{id}/` and the web viewer is updated automatically.

---

## Prerequisites

- **Node.js** v18+
- **Claude CLI** — the engine calls `claude -p "..."` to invoke Claude. Install and authenticate it first:
  ```
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
2. Pick the best debate panel for your topic
3. Run 2–4 rounds of structured cross-examination
4. Write a synthesis report to `debates/{id}/synthesis.md`

To view results in the web UI:
```bash
npx serve .
# Open http://localhost:3000/viewer/
```

---

## Framework Catalog

MACE selects 3–4 frameworks automatically based on your topic. You can also hardcode them in `config/frameworks.json`.

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
  brief.json          # Problem statement, constraints, selected frameworks
  state.json          # Rounds history, consensus level, confidence per framework
  synthesis.md        # Final report: summary, decision tree, graveyard, recommendation
  debate_data.json    # All data embedded (used by the web viewer)
  rounds/
    r1_{framework}.md       # Each framework's Round 1 position
    r1_compiled.md          # All Round 1 positions combined
    r2_{framework}.md       # Cross-examination responses
    rN_forced_{fw}.md       # Forced compromise (if deadlock)
```

`debates/index.json` — master list consumed by the viewer sidebar.

---

## Configuration

### Tuning the Engine (`mace.mjs`)

```js
const MAX_ROUNDS = 4;           // Maximum cross-examination rounds before forcing compromise
const CONSENSUS_THRESHOLD = 80; // % agreement required to conclude the debate
const MODEL_TIMEOUT_MS = 5 * 60 * 1000; // Per-model timeout (5 minutes)
```

### Adding a Framework (`config/frameworks.json`)

```json
"my_framework": {
  "name": "The Skeptic",
  "category": "universal",
  "description": "short description shown to the intake coordinator",
  "provider": "claude",
  "mandate": "Your full system prompt / cognitive constraint goes here."
}
```

Set `provider` to `claude`, `gemini`, `codex`, or any value to trigger a mock response.

### Changing the Provider per Framework

Each framework can use a different AI provider. The intake phase always uses Claude.

```json
"architect": {
  "provider": "gemini"
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
- Tabs for each round, the brief, sentiment chart, and synthesis
- Canvas-based confidence timeline per framework
- Markdown-rendered synthesis with Graveyard section highlighted

---

## License

MIT
