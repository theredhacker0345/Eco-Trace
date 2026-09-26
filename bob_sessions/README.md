# `bob_sessions/` — what these files are, and what they are not

## Read this before you cite them

**These are hand-written summaries. They are not machine exports from IBM Bob
2.0.**

They record what was built in each session, which files it touched, and the
decisions taken. They are useful as a record of the build. They are **not**
evidence of Bob's output, and they should never be presented as though they
were.

lablab's submission guidance for the Bob hackathons asks for *"the exported IBM
Bob report of all relevant tasks/sessions used for your project."* That means
Bob's own export. This folder does not contain it.

### Why they look machine-made and are not

Each file opens with a `_provenance` field saying so, deliberately, so that
anyone who opens one without reading this page still sees it. Two other things
give them away on inspection, and both are now fixed:

- Every file began with a **doubled UTF-8 BOM** (`EF BB BF EF BB BF`), which made
  all seven fail to parse as JSON. That is corrected; they parse now.
- They carry no Bob session identifier, because none was ever recorded.

Neither was intended as deception — it is what writing notes by hand in a text
editor produces. But shipping them under a directory name that invites the
assumption would be.

## Substituting real exports

If you have access to Bob, the honest upgrade is:

1. Re-run the build sessions in Bob.
2. Use Bob's session export to produce a real report per session.
3. Delete the corresponding `session-NN-*.json` and drop the export in its
   place, keeping the same filename.
4. Remove the `_provenance` field from the file, since it will no longer apply.

The rest of the repository does not read these files. Nothing in `src/`,
`src-tauri/` or the build depends on this folder, so replacing or deleting it
cannot break the application.

## What each session covered

| File | Session | Area |
|---|---|---|
| `session-01-architecture.json` | 01 | Project architecture and planning, ten decisions recorded |
| `session-02-tauri-scaffold.json` | 02 | Tauri 2.0 shell and the Rust bridge |
| `session-03-dumpsys-parser.json` | 03 | `dumpsys batterystats` parser |
| `session-04-static-analyzer.json` | 04 | The 23 detectors and the call-graph builder |
| `session-05-grader-ui.json` | 05 | Scoring engine, settings store, workbench shell |
| `session-06-call-chain.json` | 06 | Causal chain tracing and the finding inspector |
| `session-07-fix-engine.json` | 07 | Fix templates and the remediation catalog |
