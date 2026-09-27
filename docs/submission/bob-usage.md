# IBM Bob Usage Statement

Bob was used in two distinct ways: to **build** EcoTrace, and as a **reasoning
tier inside** EcoTrace. Both are visible in the repository.

## 1 · Bob built the product

The complete detector set, the call-graph tracer, the `dumpsys batterystats`
parser, the fix playbook and the interface were authored with IBM Bob 2.0. Seven
sessions are recorded verbatim in [`bob_sessions/`](../../bob_sessions/README.md):

| Session | What Bob produced |
|---|---|
| `session-01-architecture.json` | The two-tier analysis design — local detectors plus whole-repository reasoning |
| `session-02-tauri-scaffold.json` | The Tauri 2.0 shell, capability scoping and the rooted file commands |
| `session-03-dumpsys-parser.json` | The full `batterystats` parser and the delta/provenance model |
| `session-04-static-analyzer.json` | The 23 energy detectors, with the Java/Kotlin detection signals per rule |
| `session-05-grader-ui.json` | The grading engine and the three-panel workbench |
| `session-06-call-chain.json` | The call-graph builder and backwards chain tracer |
| `session-07-fix-engine.json` | The fix playbook and the verification design |

Bob also wrote `.bob/rules-agent/energy.md`: the machine-readable spec of all 23
anti-patterns — ID, category, severity, Java and Kotlin detection signals, causal
chain hook and fix template. That file is the detector contract, and Bob is the
author of it.

Because Bob wrote the rules, it could also be asked the harder question later:
where do the rules get it wrong? The most recent precision pass closed a set of
false positives (an import read as a configured HTTP client; a permission check
read as a location request; `stopSelf(startId)` read as never stopping; two
unrelated timers read as a polling loop), and each fix is now locked down by
`npm run analyzer:check`, which CI runs on every push.

## 2 · Bob is the second analysis tier in the product

`src/bob/client.ts` and `src/bob/aifix.ts` are a production client, not a demo
wrapper:

- **Whole-repository reasoning.** The local tier sees call structure; Bob sees
  every file at once, so it can revise a severity, correct a description, and
  write a fix against the exact traced chain — including for defects the local
  pass attributes to the wrong method.
- **Patches are verified, not trusted.** Bob's unified diff is applied to a
  scratch copy and the detectors re-run. A patch that silences a rule by deleting
  the construct it looked for fails verification and is refused.
- **Nothing lands unattended.** An accepted patch is committed to
  `ecotrace/ai-fix/<rule>-<file>`; the Rust command refuses a `main` branch
  outright, and pushing is off by default.
- **Infrastructure the judges can check.** Hard timeouts, exponential backoff
  with jitter honouring `Retry-After`, distinct handling of 401 / 429 / 5xx,
  token and cost accounting surfaced in the UI, and JSON extraction that
  tolerates fenced blocks, prose preambles and arrays truncated at the token
  limit.

**Bob is an enhancement, never a prerequisite.** The 23 detectors, the causal
chains, the grade, the history and the exported report all work with no key
configured — Bob requires a warning, not a fallback.
