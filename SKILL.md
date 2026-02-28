---
name: Multi-Agent Consensus Engine
description: A structured debate system using defined cognitive frameworks (personas) to cross-examine technical proposals and force consensus.
commands:
  - name: mace
    description: Starts a multi-agent debate on a specific topic.
    usage: /mace [topic or question]
disable-model-invocation: true
---

# Multi-Agent Consensus Engine (MACE)

MACE forces distinct AI personas to debate a topic, cross-examine each other's assumptions, and arrive at a battle-tested consensus.

## Installation as a Claude Code Skill

Symlink (or copy) this repo into your Claude Code skills directory so the skill can locate `mace.mjs` relative to itself:

```bash
ln -s /path/to/your/mace ~/.claude/skills/mace
```

Then reload Claude Code. The `/mace` command will be available in any project.

## Usage
Run `/mace "Should we migrate our Python billing app to Rust?"`

The engine will:
1. Run an Intake phase to define constraints.
2. Spin up 3–4 cognitive frameworks selected for your topic.
3. Run multiple rounds of divergence and cross-examination.
4. Output a `synthesis.md` and update the debate viewer.

## Execution
When invoked, the skill runs the Node orchestrator from its own directory:
`node "$(dirname "$0")/mace.mjs" "USER_PROMPT"`
