# Long Description — Problem & Solution Statement

**EcoTrace — Android Energy Intelligence Platform**

## The problem

Every Android battery tool tells you *what* is draining the battery. Battery
Historian tells you a wakelock was held for two hours. Android Profiler tells
you the radio never slept. None of them tell you *why*.

Why is not a pattern-matching problem. It is a reasoning problem: it requires
understanding how one architectural decision — a repeating alarm registered in
`MainActivity.onCreate()` — propagates through six layers of a codebase to
become a drain that only shows up on a physical device. A linter sees the last
line of that chain and stops.

## The solution

EcoTrace is a desktop application for Android engineers. It answers two
questions for every source of drain: what the code is doing wrong, and which
architectural decision put it there.

It runs **23 energy detectors** over Java and Kotlin sources — wakefulness,
network, location and lifecycle patterns such as an unclosed `WakeLock`, a
`postDelayed` polling loop, sub-30-second GPS intervals, and `JobInfo`
constraints that are written but never submitted. It then builds a **real
cross-file call graph** and walks backwards from each finding to the lifecycle
entry point that caused it, so a leaked wakelock in `NetworkManager` is reported
as the symptom of a wakeup alarm in `MainActivity` that re-arms the path 96 times
a day.

The whole repository is also ingested into **IBM Bob 2.0**, which holds every
file in a single reasoning pass: it revises severities, corrects descriptions,
and writes a fix against that specific chain — including for defects a local
pass attributes to the wrong method. Bob proposes a patch, and EcoTrace's own
detectors then re-run over it: a patch that silences a rule by deleting the
construct is rejected. Accepted changes land on a branch for a human to merge,
never straight to `main`.

For teams with devices, `adb shell dumpsys batterystats` snapshots are parsed
and differenced into a measured drain rate in mAh/min, attributed to the app
under test rather than the whole device.

## Who it is for, and why it is different

Its user is the Android engineer who has been handed a battery bug report and
has no idea where in 400 files the cause lives. They open the project, scan it
in under a second, and immediately see the deepest chain in the codebase —
ranked by severity, traced to a lifecycle method, with a fix and a grade.

Three things make it unlike the tools judges have seen:

1. **It reasons about cause, not symptoms.** The call graph is the product.
2. **It is honest about provenance.** Every number reports where it came from —
   measured, estimator-derived, or unknown — and the exported report includes a
   coverage matrix showing what was checked and found *clean*.
3. **It works without a key.** The detectors, chains, grade, history and report
   all run offline, deterministically and free. Bob makes the analysis sharper;
   it is never a prerequisite. A tool that only works when you hand it an API key
   is a demo, not a product.

Output is a self-contained HTML or PDF report that attaches to the ticket, plus
an optional one-click patch authored, verified and branched for review.
