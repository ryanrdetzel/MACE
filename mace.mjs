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

// ── Main Engine ──────────────────────────────────────────────────────────────

async function runEngine(topic) {
  if (!fs.existsSync(DEBATES_DIR)) fs.mkdirSync(DEBATES_DIR);

  const debateId = `deb-${Date.now()}`;
  const sessionDir = path.join(DEBATES_DIR, debateId);
  const roundsDir = path.join(sessionDir, "rounds");
  fs.mkdirSync(sessionDir);
  fs.mkdirSync(roundsDir);

  console.log(`\n🚀 Starting MACE Engine`);
  console.log(`   Topic : ${topic}`);
  console.log(`   ID    : ${debateId}\n`);

  // ── Phase 0: Clarifying Questions ─────────────────────────────────────────
  console.log(`🔍 Phase 0: Gathering Context`);
  const clarifyRaw = await askModel("claude", getClarifyingQuestionsPrompt(topic));
  const clarifyData = extractJson(clarifyRaw);
  let enrichedContext = topic;

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
  fs.writeFileSync(
    path.join(sessionDir, "brief.json"),
    JSON.stringify(brief, null, 2),
  );
  console.log(`   ✓ Brief: "${brief.problem_statement}"`);

  // Resolve selected frameworks — validate keys, fall back to defaults if needed
  const DEFAULT_FRAMEWORKS = ["auditor", "contrarian", "pragmatist", "architect"];
  const allFrameworkKeys = Object.keys(FRAMEWORKS.frameworks);
  const selectedKeys = Array.isArray(brief.selected_frameworks)
    ? brief.selected_frameworks.filter((k) => allFrameworkKeys.includes(k))
    : [];
  const resolvedKeys = selectedKeys.length >= 2 ? selectedKeys : DEFAULT_FRAMEWORKS;

  const MAX_ROUNDS = Number.isInteger(brief.max_rounds) && brief.max_rounds >= 2 && brief.max_rounds <= 5
    ? brief.max_rounds
    : DEFAULT_MAX_ROUNDS;
  const CONSENSUS_THRESHOLD = Number.isInteger(brief.consensus_threshold) && brief.consensus_threshold >= 50 && brief.consensus_threshold <= 85
    ? brief.consensus_threshold
    : DEFAULT_CONSENSUS_THRESHOLD;

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

  const frameworks = resolvedKeys.map((k) => [k, FRAMEWORKS.frameworks[k]]);

  // State object — persisted at the end and after each round
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

  // ── Phase 2a: Round 1 — Divergence ────────────────────────────────────────
  console.log(`⚔️  Phase 2: Round 1 — Divergence (parallel)`);

  const round1Outputs = await Promise.all(
    frameworks.map(([key, f]) => {
      console.log(`   → ${f.name} analyzing...`);
      return askModel(f.provider, getRound1Prompt(brief, f)).then((res) => ({
        key,
        f,
        res,
      }));
    }),
  );

  let round1Compiled = "";
  for (const { key, f, res } of round1Outputs) {
    const conf = extractConfidence(res);
    state.participants.find((p) => p.role === key).confidence_history.push(conf);
    fs.writeFileSync(path.join(roundsDir, `r1_${key}.md`), res);
    round1Compiled += `\n\n### ${f.name}\n\n${res}`;
    console.log(`   ✓ ${f.name} (confidence: ${conf}%)`);
  }

  fs.writeFileSync(path.join(roundsDir, "r1_compiled.md"), round1Compiled);
  state.history.push({ round: 1, type: "divergence", file: "r1_compiled.md" });

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

    const crossOutputs = await Promise.all(
      frameworks.map(([key, f]) => {
        console.log(`   → ${f.name} critiquing peers...`);
        return askModel(
          f.provider,
          getCrossExaminationPrompt(brief, f, currentRoundText),
        ).then((res) => ({ key, f, res }));
      }),
    );

    let roundCompiled = "";
    for (const { key, f, res } of crossOutputs) {
      const conf = extractConfidence(res);
      state.participants
        .find((p) => p.role === key)
        .confidence_history.push(conf);
      fs.writeFileSync(path.join(roundsDir, `r${round}_${key}.md`), res);
      roundCompiled += `\n\n### ${f.name}\n\n${res}`;
      console.log(`   ✓ ${f.name} (confidence: ${conf}%)`);
    }

    fs.writeFileSync(path.join(roundsDir, `r${round}_compiled.md`), roundCompiled);
    state.history.push({
      round,
      type: "cross_examination",
      file: `r${round}_compiled.md`,
    });

    allDebateText += `\n\n---\n\n${roundCompiled}`;
    currentRoundText = roundCompiled;

    // Moderator assesses convergence
    console.log(`\n🔭 Moderator: assessing consensus...`);
    const convRaw = await askModel(
      "claude",
      getConvergencePrompt(brief, allDebateText, round),
    );
    convergenceData = extractJson(convRaw) ?? convergenceData;
    state.consensus_level = convergenceData.consensus_level ?? 0;

    console.log(`   Consensus: ${state.consensus_level}%`);
    if (state.consensus_level >= CONSENSUS_THRESHOLD) {
      console.log(`   ✅ Consensus reached — concluding debate.`);
      break;
    }

    if (round === MAX_ROUNDS) {
      // Force compromise: max rounds exhausted
      console.log(
        `\n🔨 Moderator: max rounds reached — forcing compromise on deadlocked issues`,
      );

      const forcedOutputs = await Promise.all(
        frameworks.map(([key, f]) => {
          console.log(`   → ${f.name} proposing compromise...`);
          return askModel(
            f.provider,
            getForcedCompromisePrompt(
              brief,
              f,
              convergenceData.deadlock_issues ?? [],
              currentRoundText,
            ),
          ).then((res) => ({ key, f, res }));
        }),
      );

      let forcedCompiled = "";
      for (const { key, f, res } of forcedOutputs) {
        const conf = extractConfidence(res);
        state.participants
          .find((p) => p.role === key)
          .confidence_history.push(conf);
        fs.writeFileSync(
          path.join(roundsDir, `r${round}_forced_${key}.md`),
          res,
        );
        forcedCompiled += `\n\n### ${f.name} (Forced Compromise)\n\n${res}`;
        console.log(`   ✓ ${f.name} (confidence: ${conf}%)`);
      }

      const forcedFile = `r${round}_forced_compiled.md`;
      fs.writeFileSync(path.join(roundsDir, forcedFile), forcedCompiled);
      state.history.push({
        round,
        type: "forced_compromise",
        file: forcedFile,
      });
      allDebateText += `\n\n---\n\n${forcedCompiled}`;
      currentRoundText = forcedCompiled;
    } else {
      console.log(`   → Deadlock at ${state.consensus_level}% — continuing to Round ${round + 1}...`);
    }
  }

  // ── Phase 3: Synthesis ────────────────────────────────────────────────────
  console.log(`\n🎯 Phase 3: Generating Final Synthesis...`);

  const synthesisRaw = await askModel(
    "claude",
    getSynthesisPrompt(brief, allDebateText, state.participants),
  );
  fs.writeFileSync(path.join(sessionDir, "synthesis.md"), synthesisRaw);

  state.status = "completed";
  state.completed_at = new Date().toISOString();
  fs.writeFileSync(
    path.join(sessionDir, "state.json"),
    JSON.stringify(state, null, 2),
  );

  // debate_data.json — all content embedded for viewer
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
            content: fs.existsSync(filePath)
              ? fs.readFileSync(filePath, "utf-8")
              : null,
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

  // Update global index for the viewer
  updateIndex({
    id: debateId,
    topic: brief.problem_statement,
    status: "completed",
    consensus_level: state.consensus_level,
    rounds: state.history.length,
    completed_at: state.completed_at,
  });

  console.log(`\n✅ Debate complete!`);
  console.log(`   Consensus  : ${state.consensus_level}%`);
  console.log(`   Rounds     : ${state.history.length}`);
  console.log(`   Artifacts  : ${sessionDir}`);
  console.log(`   Viewer     : npx serve . then open http://localhost:3000/viewer\n`);
}

// ── Entry Point ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length > 0) {
  runEngine(args.join(" ")).catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
} else {
  console.log('Usage: node mace.mjs "Your topic here"');
  console.log('Example: node mace.mjs "Should we migrate from REST to GraphQL?"');
}
