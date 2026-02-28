import fs from "fs";
import path from "path";
import readline from "readline";
import { spawn } from "child_process";
import {
  getClarifyingQuestionsPrompt,
  getIntakePrompt,
  getRound1Prompt,
  getCrossExaminationPrompt,
  getConvergencePrompt,
  getForcedCompromisePrompt,
  getSynthesisPrompt,
} from "./config/prompts.mjs";

const DEBATES_DIR = path.join(process.cwd(), "debates");
const FRAMEWORKS = JSON.parse(
  fs.readFileSync(new URL("./config/frameworks.json", import.meta.url)),
);

const DEFAULT_MAX_ROUNDS = 3;
const DEFAULT_CONSENSUS_THRESHOLD = 70;

// ── Model Invocation ────────────────────────────────────────────────────────

const MODEL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per call

function askModel(provider, prompt) {
  return new Promise((resolve) => {
    let output = "";
    let errorOutput = "";
    let child;
    let settled = false;

    function done(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    }

    let ticker;
    const timer = setTimeout(() => {
      clearInterval(ticker);
      process.stdout.write(`                                          \r`);
      console.error(`  ⏱  ${provider} timed out after ${MODEL_TIMEOUT_MS / 1000}s — killing process`);
      try { child?.kill(); } catch {}
      done(`[Timeout from ${provider}]`);
    }, MODEL_TIMEOUT_MS);

    try {
      const spawnOpts = { stdio: ["ignore", "pipe", "pipe"] };
      if (provider === "claude") {
        child = spawn("claude", ["-p", prompt], spawnOpts);
      } else if (provider === "gemini") {
        child = spawn("gemini", ["-o", "text", prompt], spawnOpts);
      } else if (provider === "codex") {
        child = spawn("codex", ["exec", "--full-auto", prompt], spawnOpts);
      } else {
        done(`[Mock from ${provider}]: Analysis complete.`);
        return;
      }

      const start = Date.now();
      ticker = setInterval(() => {
        const s = ((Date.now() - start) / 1000).toFixed(0);
        process.stdout.write(`  ↳ waiting for ${provider}... ${s}s\r`);
      }, 1000);

      child.stdout.on("data", (d) => (output += d.toString()));
      child.stderr.on("data", (d) => (errorOutput += d.toString()));
      child.on("close", (code) => {
        clearInterval(ticker);
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        process.stdout.write(`                                          \r`);
        if (code === 0 && output.trim()) console.log(`  ↳ ${provider} responded in ${elapsed}s`);
        if (code !== 0 || !output.trim()) {
          console.error(
            `  ⚠️  ${provider} failed (exit ${code}): ${errorOutput.slice(0, 200)}`,
          );
          done(`[Error from ${provider}: process exited with code ${code}]`);
        } else {
          done(output.trim());
        }
      });
      child.on("error", (err) => {
        console.error(`  ⚠️  Could not spawn ${provider}: ${err.message}`);
        done(`[Error: ${provider} CLI not found or not installed]`);
      });
    } catch (e) {
      done(`[Error from ${provider}: ${e.message}]`);
    }
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function extractConfidence(text) {
  const match = text.match(/confidence[:\s]+(\d+)/i);
  return match ? Math.min(100, Math.max(0, parseInt(match[1], 10))) : 50;
}

function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function updateIndex(entry) {
  const indexPath = path.join(DEBATES_DIR, "index.json");
  let data = { debates: [] };
  if (fs.existsSync(indexPath)) {
    try {
      data = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    } catch {
      /* corrupted index — start fresh */
    }
  }
  data.debates = data.debates.filter((d) => d.id !== entry.id);
  data.debates.unshift(entry);
  fs.writeFileSync(indexPath, JSON.stringify(data, null, 2));
}

function saveState(sessionDir, state) {
  fs.writeFileSync(
    path.join(sessionDir, "state.json"),
    JSON.stringify(state, null, 2),
  );
}

// ── Interactive Input ─────────────────────────────────────────────────────────

function askUser(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── Round Runner (handles cached files for resume) ───────────────────────────
// Returns { compiled, compiledFile }

async function runFrameworks(roundNum, roundType, frameworks, brief, state, roundsDir, contextText, deadlockIssues) {
  const filePrefix = roundType === "forced_compromise" ? `r${roundNum}_forced_` : `r${roundNum}_`;
  const compiledFile = roundType === "forced_compromise"
    ? `r${roundNum}_forced_compiled.md`
    : `r${roundNum}_compiled.md`;

  const outputs = await Promise.all(
    frameworks.map(([key, f]) => {
      const filePath = path.join(roundsDir, `${filePrefix}${key}.md`);
      if (fs.existsSync(filePath)) {
        console.log(`   ↩ ${f.name} (resuming from saved file)`);
        return Promise.resolve({ key, f, res: fs.readFileSync(filePath, "utf-8"), cached: true });
      }
      let prompt;
      if (roundType === "divergence") {
        prompt = getRound1Prompt(brief, f);
        console.log(`   → ${f.name} analyzing...`);
      } else if (roundType === "forced_compromise") {
        prompt = getForcedCompromisePrompt(brief, f, deadlockIssues ?? [], contextText);
        console.log(`   → ${f.name} proposing compromise...`);
      } else {
        prompt = getCrossExaminationPrompt(brief, f, contextText);
        console.log(`   → ${f.name} critiquing peers...`);
      }
      return askModel(f.provider, prompt).then((res) => ({ key, f, res, cached: false }));
    }),
  );

  let compiled = "";
  for (const { key, f, res, cached } of outputs) {
    const filePath = path.join(roundsDir, `${filePrefix}${key}.md`);
    if (!cached) {
      const conf = extractConfidence(res);
      state.participants.find((p) => p.role === key).confidence_history.push(conf);
      fs.writeFileSync(filePath, res);
      console.log(`   ✓ ${f.name} (confidence: ${conf}%)`);
    } else {
      console.log(`   ✓ ${f.name} (confidence: ${extractConfidence(res)}%, cached)`);
    }
    const label = roundType === "forced_compromise" ? `${f.name} (Forced Compromise)` : f.name;
    compiled += `\n\n### ${label}\n\n${res}`;
  }

  fs.writeFileSync(path.join(roundsDir, compiledFile), compiled);
  return { compiled, compiledFile };
}

// ── Finalize: write debate_data.json and update index ───────────────────────

function finalizeDebate(sessionDir, roundsDir, state, brief, convergenceData, synthesisRaw, frameworks) {
  state.status = "completed";
  state.completed_at = new Date().toISOString();
  saveState(sessionDir, state);

  const debateData = {
    ...state,
    brief,
    convergence: convergenceData,
    rounds: state.history.map((h) => ({
      ...h,
      content: fs.readFileSync(path.join(roundsDir, h.file), "utf-8"),
      perFramework: frameworks
        .map(([key, f]) => {
          const filePath = path.join(roundsDir, `r${h.round}_${key}.md`);
          return {
            role: key,
            name: f.name,
            provider: f.provider,
            content: fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : null,
          };
        })
        .filter((fw) => fw.content !== null),
    })),
    synthesis: synthesisRaw,
  };

  fs.writeFileSync(
    path.join(sessionDir, "debate_data.json"),
    JSON.stringify(debateData, null, 2),
  );

  updateIndex({
    id: state.id,
    topic: brief.problem_statement,
    status: "completed",
    consensus_level: state.consensus_level,
    rounds: state.history.length,
    completed_at: state.completed_at,
    prior_debate_id: brief.prior_debate_id ?? null,
  });
}

// ── Resolve framework config from brief ─────────────────────────────────────

function resolveFrameworks(brief) {
  const DEFAULT_FRAMEWORKS = ["auditor", "contrarian", "pragmatist", "architect"];
  const allFrameworkKeys = Object.keys(FRAMEWORKS.frameworks);
  const selectedKeys = Array.isArray(brief.selected_frameworks)
    ? brief.selected_frameworks.filter((k) => allFrameworkKeys.includes(k))
    : [];
  const resolvedKeys = selectedKeys.length >= 2 ? selectedKeys : DEFAULT_FRAMEWORKS;

  const MAX_ROUNDS = Number.isInteger(brief.max_rounds) && brief.max_rounds >= 2 && brief.max_rounds <= 5
    ? brief.max_rounds : DEFAULT_MAX_ROUNDS;
  const CONSENSUS_THRESHOLD = Number.isInteger(brief.consensus_threshold) && brief.consensus_threshold >= 50 && brief.consensus_threshold <= 85
    ? brief.consensus_threshold : DEFAULT_CONSENSUS_THRESHOLD;

  return {
    resolvedKeys,
    frameworks: resolvedKeys.map((k) => [k, FRAMEWORKS.frameworks[k]]),
    MAX_ROUNDS,
    CONSENSUS_THRESHOLD,
  };
}

// ── Main Engine ──────────────────────────────────────────────────────────────

async function runEngine(topic, { priorDebateId = null } = {}) {
  if (!fs.existsSync(DEBATES_DIR)) fs.mkdirSync(DEBATES_DIR);

  const debateId = `deb-${Date.now()}`;
  const sessionDir = path.join(DEBATES_DIR, debateId);
  const roundsDir = path.join(sessionDir, "rounds");
  fs.mkdirSync(sessionDir);
  fs.mkdirSync(roundsDir);

  console.log(`\n🚀 Starting MACE Engine`);
  console.log(`   Topic : ${topic}`);
  console.log(`   ID    : ${debateId}\n`);

  // ── Load prior debate context (if --followon) ──────────────────────────────
  let priorContext = "";
  if (priorDebateId) {
    const priorDir = path.join(DEBATES_DIR, priorDebateId);
    if (!fs.existsSync(priorDir)) {
      console.warn(`   ⚠️  Prior debate ${priorDebateId} not found — proceeding without it\n`);
    } else {
      const priorBriefPath = path.join(priorDir, "brief.json");
      const priorSynthesisPath = path.join(priorDir, "synthesis.md");
      const priorBrief = fs.existsSync(priorBriefPath)
        ? JSON.parse(fs.readFileSync(priorBriefPath, "utf-8"))
        : null;
      const priorSynthesis = fs.existsSync(priorSynthesisPath)
        ? fs.readFileSync(priorSynthesisPath, "utf-8")
        : null;

      if (priorBrief || priorSynthesis) {
        priorContext = `\n\n---\nThis debate follows on from a prior debate (ID: ${priorDebateId}).`;
        if (priorBrief?.problem_statement) {
          priorContext += `\nPrior topic: "${priorBrief.problem_statement}"`;
        }
        if (priorSynthesis) {
          priorContext += `\n\nConclusions and synthesis from the prior debate:\n${priorSynthesis}`;
        }
        console.log(`   ✓ Prior debate : "${priorBrief?.problem_statement ?? priorDebateId}"\n`);
      }
    }
  }

  // ── Phase 0: Clarifying Questions ─────────────────────────────────────────
  console.log(`🔍 Phase 0: Gathering Context`);
  // Inject prior context into the topic so clarifying questions are informed by it
  const topicWithPrior = priorContext ? `${topic}${priorContext}` : topic;
  const clarifyRaw = await askModel("claude", getClarifyingQuestionsPrompt(topicWithPrior));
  const clarifyData = extractJson(clarifyRaw);
  let enrichedContext = topicWithPrior;

  if (clarifyData?.questions?.length > 0) {
    console.log(`\n   The following questions will help focus the debate:`);
    console.log(`   (Press Enter to skip any question)\n`);
    const answers = [];
    for (let i = 0; i < clarifyData.questions.length; i++) {
      const q = clarifyData.questions[i];
      console.log(`   Q${i + 1}: ${q}`);
      const answer = await askUser(`   Your answer: `);
      if (answer) answers.push({ question: q, answer });
      console.log();
    }
    if (answers.length > 0) {
      const qaBlock = answers.map((qa) => `- ${qa.question}\n  ${qa.answer}`).join("\n");
      enrichedContext = `${topic}\n\nAdditional context provided by the user:\n${qaBlock}`;
      console.log(`   ✓ Context enriched with ${answers.length} answer(s)\n`);
    } else {
      console.log(`   ✓ No additional context provided — proceeding with original topic\n`);
    }
  } else {
    console.log(`   ✓ No clarifying questions needed — topic is self-contained\n`);
  }

  // ── Phase 1: Intake ────────────────────────────────────────────────────────
  console.log(`📋 Phase 1: Pre-Flight Intake`);
  const intakeRaw = await askModel("claude", getIntakePrompt(enrichedContext, FRAMEWORKS.frameworks));
  const brief = extractJson(intakeRaw) ?? {
    problem_statement: topic,
    assumed_constraints: [],
    success_criteria: "Consensus reached among all frameworks.",
    selected_frameworks: null,
    selection_rationale: null,
  };

  // Persist enrichedContext so resume can reconstruct prompts correctly
  brief.enrichedContext = enrichedContext;
  if (priorDebateId) brief.prior_debate_id = priorDebateId;

  fs.writeFileSync(path.join(sessionDir, "brief.json"), JSON.stringify(brief, null, 2));
  console.log(`   ✓ Brief: "${brief.problem_statement}"`);

  const { resolvedKeys, frameworks, MAX_ROUNDS, CONSENSUS_THRESHOLD } = resolveFrameworks(brief);

  if (brief.selection_rationale) {
    console.log(`   ✓ Panel : ${resolvedKeys.join(", ")}`);
    console.log(`   ✓ Why   : ${brief.selection_rationale}`);
  } else {
    console.log(`   ✓ Panel : ${resolvedKeys.join(", ")} (default)`);
  }
  console.log(`   ✓ Threshold : ${CONSENSUS_THRESHOLD}% consensus to conclude`);
  console.log(`   ✓ Max rounds: ${MAX_ROUNDS}`);
  if (brief.parameter_rationale) console.log(`   ✓ Why   : ${brief.parameter_rationale}`);
  console.log();

  // State object — saved incrementally after each phase
  const state = {
    id: debateId,
    topic: brief.problem_statement,
    status: "in_progress",
    current_round: 1,
    consensus_level: 0,
    history: [],
    participants: frameworks.map(([key, f]) => ({
      role: key,
      name: f.name,
      provider: f.provider,
      confidence_history: [],
    })),
  };
  saveState(sessionDir, state);

  // ── Phase 2a: Round 1 — Divergence ────────────────────────────────────────
  console.log(`⚔️  Phase 2: Round 1 — Divergence (parallel)`);
  const { compiled: round1Compiled, compiledFile: r1File } = await runFrameworks(
    1, "divergence", frameworks, brief, state, roundsDir, null, null,
  );
  state.history.push({ round: 1, type: "divergence", file: r1File });
  saveState(sessionDir, state);

  // ── Phase 2b: Convergence Loop ────────────────────────────────────────────
  let currentRoundText = round1Compiled;
  let allDebateText = round1Compiled;
  let convergenceData = {
    consensus_level: 0,
    points_of_agreement: [],
    points_of_friction: [],
    deadlock_issues: [],
  };

  for (let round = 2; round <= MAX_ROUNDS; round++) {
    console.log(`\n⚖️  Round ${round}: Cross-Examination`);
    state.current_round = round;

    const { compiled: roundCompiled, compiledFile } = await runFrameworks(
      round, "cross_examination", frameworks, brief, state, roundsDir, currentRoundText, null,
    );
    state.history.push({ round, type: "cross_examination", file: compiledFile });

    allDebateText += `\n\n---\n\n${roundCompiled}`;
    currentRoundText = roundCompiled;

    // Moderator assesses convergence
    console.log(`\n🔭 Moderator: assessing consensus...`);
    const convRaw = await askModel("claude", getConvergencePrompt(brief, allDebateText, round));
    convergenceData = extractJson(convRaw) ?? convergenceData;
    state.consensus_level = convergenceData.consensus_level ?? 0;
    state.last_convergence = convergenceData;
    saveState(sessionDir, state);

    console.log(`   Consensus: ${state.consensus_level}%`);
    if (state.consensus_level >= CONSENSUS_THRESHOLD) {
      console.log(`   ✅ Consensus reached — concluding debate.`);
      break;
    }

    if (round === MAX_ROUNDS) {
      console.log(`\n🔨 Moderator: max rounds reached — forcing compromise on deadlocked issues`);

      const { compiled: forcedCompiled, compiledFile: forcedFile } = await runFrameworks(
        round, "forced_compromise", frameworks, brief, state, roundsDir,
        currentRoundText, convergenceData.deadlock_issues ?? [],
      );
      state.history.push({ round, type: "forced_compromise", file: forcedFile });
      allDebateText += `\n\n---\n\n${forcedCompiled}`;
      currentRoundText = forcedCompiled;
      saveState(sessionDir, state);
    } else {
      console.log(`   → Deadlock at ${state.consensus_level}% — continuing to Round ${round + 1}...`);
    }
  }

  // ── Phase 3: Synthesis ────────────────────────────────────────────────────
  console.log(`\n🎯 Phase 3: Generating Final Synthesis...`);
  const synthesisRaw = await askModel("claude", getSynthesisPrompt(brief, allDebateText, state.participants));
  fs.writeFileSync(path.join(sessionDir, "synthesis.md"), synthesisRaw);

  finalizeDebate(sessionDir, roundsDir, state, brief, convergenceData, synthesisRaw, frameworks);

  console.log(`\n✅ Debate complete!`);
  console.log(`   Consensus  : ${state.consensus_level}%`);
  console.log(`   Rounds     : ${state.history.length}`);
  console.log(`   Artifacts  : ${sessionDir}`);
  console.log(`   Viewer     : npx serve . then open http://localhost:3000/viewer\n`);
}

// ── Resume Engine ─────────────────────────────────────────────────────────────

async function resumeEngine(debateId) {
  const sessionDir = path.join(DEBATES_DIR, debateId);
  const roundsDir = path.join(sessionDir, "rounds");

  if (!fs.existsSync(sessionDir)) {
    console.error(`\n❌ Debate not found: ${debateId}`);
    process.exit(1);
  }

  const briefPath = path.join(sessionDir, "brief.json");
  if (!fs.existsSync(briefPath)) {
    console.error(`\n❌ No brief.json found — debate cannot be resumed (nothing was saved before failure)`);
    process.exit(1);
  }

  console.log(`\n🔄 Resuming MACE Debate`);
  console.log(`   ID    : ${debateId}\n`);

  const brief = JSON.parse(fs.readFileSync(briefPath, "utf-8"));

  // Already done?
  if (fs.existsSync(path.join(sessionDir, "synthesis.md"))) {
    console.log(`   ✓ This debate already completed. View it in the viewer.`);
    console.log(`   Viewer: npx serve . then open http://localhost:3000/viewer\n`);
    return;
  }

  const { resolvedKeys, frameworks, MAX_ROUNDS, CONSENSUS_THRESHOLD } = resolveFrameworks(brief);

  // Load or reconstruct state
  let state;
  if (fs.existsSync(path.join(sessionDir, "state.json"))) {
    state = JSON.parse(fs.readFileSync(path.join(sessionDir, "state.json"), "utf-8"));
    state.status = "in_progress";
  } else {
    state = {
      id: debateId,
      topic: brief.problem_statement,
      status: "in_progress",
      current_round: 1,
      consensus_level: 0,
      history: [],
      participants: frameworks.map(([key, f]) => ({
        role: key, name: f.name, provider: f.provider, confidence_history: [],
      })),
    };
  }

  // Ensure participants list matches current frameworks (handles missing/old state)
  if (!Array.isArray(state.participants) || state.participants.length === 0) {
    state.participants = frameworks.map(([key, f]) => ({
      role: key, name: f.name, provider: f.provider, confidence_history: [],
    }));
  }

  // Reconstruct confidence_history from saved files if missing (older debates)
  for (const [key] of frameworks) {
    const participant = state.participants.find((p) => p.role === key);
    if (participant && participant.confidence_history.length === 0) {
      for (let r = 1; r <= MAX_ROUNDS; r++) {
        const regular = path.join(roundsDir, `r${r}_${key}.md`);
        const forced = path.join(roundsDir, `r${r}_forced_${key}.md`);
        if (fs.existsSync(regular)) {
          participant.confidence_history.push(extractConfidence(fs.readFileSync(regular, "utf-8")));
        } else if (fs.existsSync(forced)) {
          participant.confidence_history.push(extractConfidence(fs.readFileSync(forced, "utf-8")));
          break;
        } else {
          break;
        }
      }
    }
  }

  // Reconstruct allDebateText from compiled round files
  let allDebateText = "";
  let currentRoundText = "";
  let lastCompletedRound = 0;
  let forcedCompromiseDone = false;

  for (let r = 1; r <= MAX_ROUNDS; r++) {
    const compiledPath = path.join(roundsDir, `r${r}_compiled.md`);
    const forcedPath = path.join(roundsDir, `r${r}_forced_compiled.md`);

    if (fs.existsSync(compiledPath)) {
      const content = fs.readFileSync(compiledPath, "utf-8");
      allDebateText = r === 1 ? content : allDebateText + `\n\n---\n\n${content}`;
      currentRoundText = content;
      lastCompletedRound = r;

      // Check for forced compromise on the same round
      if (fs.existsSync(forcedPath)) {
        const forcedContent = fs.readFileSync(forcedPath, "utf-8");
        allDebateText += `\n\n---\n\n${forcedContent}`;
        currentRoundText = forcedContent;
        forcedCompromiseDone = true;
        break;
      }
    } else {
      break;
    }
  }

  // Reconstruct history from files if state.history is empty (older debates)
  if (state.history.length === 0) {
    for (let r = 1; r <= MAX_ROUNDS; r++) {
      if (fs.existsSync(path.join(roundsDir, `r${r}_compiled.md`))) {
        state.history.push({
          round: r, type: r === 1 ? "divergence" : "cross_examination",
          file: `r${r}_compiled.md`,
        });
      }
      if (fs.existsSync(path.join(roundsDir, `r${r}_forced_compiled.md`))) {
        state.history.push({ round: r, type: "forced_compromise", file: `r${r}_forced_compiled.md` });
        break;
      }
      if (!fs.existsSync(path.join(roundsDir, `r${r}_compiled.md`))) break;
    }
  }

  console.log(`   ✓ Brief     : "${brief.problem_statement}"`);
  console.log(`   ✓ Panel     : ${resolvedKeys.join(", ")}`);
  console.log(`   ✓ Threshold : ${CONSENSUS_THRESHOLD}% | Max rounds: ${MAX_ROUNDS}`);
  console.log(`   ✓ Progress  : ${lastCompletedRound} round(s) saved${forcedCompromiseDone ? " + forced compromise" : ""}`);

  let convergenceData = {
    consensus_level: state.consensus_level ?? 0,
    points_of_agreement: [],
    points_of_friction: [],
    deadlock_issues: state.last_convergence?.deadlock_issues ?? [],
  };

  // ── Determine where to resume ─────────────────────────────────────────────

  if (lastCompletedRound === 0) {
    // Nothing was saved — run Round 1
    console.log(`   → No rounds saved. Starting from Round 1.\n`);
    console.log(`⚔️  Phase 2: Round 1 — Divergence (parallel)`);
    const { compiled, compiledFile } = await runFrameworks(
      1, "divergence", frameworks, brief, state, roundsDir, null, null,
    );
    state.history.push({ round: 1, type: "divergence", file: compiledFile });
    state.current_round = 1;
    saveState(sessionDir, state);
    allDebateText = compiled;
    currentRoundText = compiled;
    lastCompletedRound = 1;
  } else if (forcedCompromiseDone) {
    // All rounds including forced compromise done — only synthesis missing
    console.log(`   → All rounds complete. Resuming synthesis only.\n`);
  } else {
    console.log(`   → Resuming from Round ${lastCompletedRound + 1}.\n`);
  }

  // ── Run convergence loop from where we left off ───────────────────────────

  if (!forcedCompromiseDone) {
    // If last round is done but convergence was never assessed, re-assess it
    if (lastCompletedRound >= 2 && !state.last_convergence) {
      console.log(`\n🔭 Moderator: re-assessing consensus for Round ${lastCompletedRound}...`);
      const convRaw = await askModel("claude", getConvergencePrompt(brief, allDebateText, lastCompletedRound));
      convergenceData = extractJson(convRaw) ?? convergenceData;
      state.consensus_level = convergenceData.consensus_level ?? 0;
      state.last_convergence = convergenceData;
      saveState(sessionDir, state);
      console.log(`   Consensus: ${state.consensus_level}%`);
    } else if (state.last_convergence) {
      convergenceData = state.last_convergence;
    }

    const alreadyConverged = state.consensus_level >= CONSENSUS_THRESHOLD;

    if (alreadyConverged) {
      console.log(`   ✅ Consensus already reached (${state.consensus_level}%) — skipping to synthesis.`);
    } else {
      for (let round = lastCompletedRound + 1; round <= MAX_ROUNDS; round++) {
        console.log(`\n⚖️  Round ${round}: Cross-Examination`);
        state.current_round = round;

        const { compiled: roundCompiled, compiledFile } = await runFrameworks(
          round, "cross_examination", frameworks, brief, state, roundsDir, currentRoundText, null,
        );
        state.history.push({ round, type: "cross_examination", file: compiledFile });

        allDebateText += `\n\n---\n\n${roundCompiled}`;
        currentRoundText = roundCompiled;

        console.log(`\n🔭 Moderator: assessing consensus...`);
        const convRaw = await askModel("claude", getConvergencePrompt(brief, allDebateText, round));
        convergenceData = extractJson(convRaw) ?? convergenceData;
        state.consensus_level = convergenceData.consensus_level ?? 0;
        state.last_convergence = convergenceData;
        saveState(sessionDir, state);

        console.log(`   Consensus: ${state.consensus_level}%`);
        if (state.consensus_level >= CONSENSUS_THRESHOLD) {
          console.log(`   ✅ Consensus reached — concluding debate.`);
          break;
        }

        if (round === MAX_ROUNDS) {
          console.log(`\n🔨 Moderator: max rounds reached — forcing compromise on deadlocked issues`);
          const { compiled: forcedCompiled, compiledFile: forcedFile } = await runFrameworks(
            round, "forced_compromise", frameworks, brief, state, roundsDir,
            currentRoundText, convergenceData.deadlock_issues ?? [],
          );
          state.history.push({ round, type: "forced_compromise", file: forcedFile });
          allDebateText += `\n\n---\n\n${forcedCompiled}`;
          currentRoundText = forcedCompiled;
          saveState(sessionDir, state);
        } else {
          console.log(`   → Deadlock at ${state.consensus_level}% — continuing to Round ${round + 1}...`);
        }
      }
    }
  }

  // ── Phase 3: Synthesis ────────────────────────────────────────────────────
  console.log(`\n🎯 Phase 3: Generating Final Synthesis...`);
  const synthesisRaw = await askModel("claude", getSynthesisPrompt(brief, allDebateText, state.participants));
  fs.writeFileSync(path.join(sessionDir, "synthesis.md"), synthesisRaw);

  finalizeDebate(sessionDir, roundsDir, state, brief, convergenceData, synthesisRaw, frameworks);

  console.log(`\n✅ Debate resumed and completed!`);
  console.log(`   Consensus  : ${state.consensus_level}%`);
  console.log(`   Rounds     : ${state.history.length}`);
  console.log(`   Artifacts  : ${sessionDir}`);
  console.log(`   Viewer     : npx serve . then open http://localhost:3000/viewer\n`);
}

// ── Entry Point ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args[0] === "--resume" && args[1]) {
  resumeEngine(args[1]).catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
} else if (args[0] === "--followon" && args[1] && args.length > 2) {
  const priorDebateId = args[1];
  const topic = args.slice(2).join(" ");
  runEngine(topic, { priorDebateId }).catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
} else if (args.length > 0 && !args[0].startsWith("--")) {
  runEngine(args.join(" ")).catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
} else {
  console.log('Usage:');
  console.log('  node mace.mjs "Your topic here"');
  console.log('  node mace.mjs --resume <debate-id>');
  console.log('  node mace.mjs --followon <debate-id> "Follow-on topic"');
  console.log('');
  console.log('Examples:');
  console.log('  node mace.mjs "Should we migrate from REST to GraphQL?"');
  console.log('  node mace.mjs --resume deb-1234567890');
  console.log('  node mace.mjs --followon deb-1234567890 "Given the GraphQL decision, how should we handle auth?"');
}
