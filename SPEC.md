# Multi-Agent Consensus Engine (MACE) 
**Technical Specification & Implementation Plan**

## 1. Overview
The Multi-Agent Consensus Engine (MACE) is an evolution of the AI Debate Hub. It shifts the paradigm from "multi-model chat" to a **structured cognitive state machine**. Instead of polite roleplay, MACE enforces distinct cognitive frameworks (personas) that cross-examine each other to forge highly robust, battle-tested solutions.

**Core Philosophy:** * **The "How" over the "Who":** Agents are defined by strict reasoning constraints, not just the underlying LLM provider.
* **Intake Before Debate:** A pre-flight phase defines constraints to prevent hallucinations and ungrounded debates.
* **Measurable Consensus:** The debate is a state machine that progresses from Divergence -> Cross-Examination -> Convergence.

---

## 2. Architecture & Workflow

### Phase 1: The Intake (Pre-Flight)
Before any debate begins, a Coordinator Agent interviews the user or parses the initial prompt to define the boundaries.
* **Input:** Raw user prompt (e.g., "Should we migrate from REST to GraphQL?")
* **Output (`brief.json`):**
  * `problem_statement`: The core issue.
  * `constraints`: Hard rules (e.g., "Must be backwards compatible", "No new infrastructure").
  * `success_criteria`: What constitutes a resolved debate.
  * `selected_frameworks`: The specific personas assigned to this debate.

### Phase 2: The State Machine (Debate Loop)
1. **Round 1 (Divergence):** Each assigned framework generates an independent analysis based purely on the `brief.json` and their specific cognitive constraint.
2. **Round 2+ (Cross-Examination):** Agents ingest the Round 1 outputs of their peers. Their prompt explicitly mandates: *"Identify the 3 most dangerous assumptions in your peers' logic based on your framework."*
3. **Round X (Convergence):** The Moderator assesses if consensus is met (e.g., 80% agreement). If a deadlock occurs, the Moderator forces a compromise prompt: *"Propose a hybrid solution that satisfies both [Constraint A] and [Constraint B]."*

### Phase 3: Synthesis & Artifact Generation
The final output is compiled into a `synthesis.md` and a rich `viewer.html` interface.
* **The Decision Tree:** A flowchart mapping proposed -> debated -> accepted/discarded ideas.
* **The Graveyard:** Explicit documentation of discarded solutions and *why* they failed the debate.
* **Sentiment Tracking:** Confidence scores tracking how each framework shifted its stance over the rounds.

---

## 3. Configuration & Data Structures

### `config/frameworks.yaml`
This defines the cognitive frameworks that can be applied to any underlying LLM (Claude, Gemini, OpenAI, local models).

```yaml
frameworks:
  architect:
    name: "The Architect"
    focus: "Systems Thinking & Scalability"
    prompt: "You evaluate solutions based on long-term maintenance, decoupling, and architectural soundness. Ignore short-term development speed."
  auditor:
    name: "The Auditor"
    focus: "Falsification & Risk"
    prompt: "Your goal is to find why a proposal will fail. Look for edge cases, security vulnerabilities, and 'Black Swan' events. Do not agree easily."
  pragmatist:
    name: "The Product Lead"
    focus: "Developer Experience & ROI"
    prompt: "Focus entirely on time-to-market, local developer experience, and cost. Challenge over-engineered solutions."
  contrarian:
    name: "The Devil's Advocate"
    focus: "Anti-Consensus"
    prompt: "You must argue for the exact opposite of the emerging consensus. If they want microservices, you argue for a monolith."
