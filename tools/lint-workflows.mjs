import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";

/*
 * Parses every workflow in .github/workflows.
 *
 * A workflow with invalid YAML does not fail loudly. GitHub reports it as a
 * syntax error at dispatch time, so the file sits there looking fine until the
 * moment somebody needs to publish a release -- which is the worst possible time
 * to discover it. This one found a real instance: `release.yml` had a
 * single-quoted YAML scalar wrapping an expression that itself contained single
 * quotes, so the scalar closed early and the whole release path was dead.
 *
 * Run by `npm run workflow:lint`, and by CI on every push.
 */

const dir = ".github/workflows";
let failures = 0;
let checked = 0;

for (const name of readdirSync(dir).sort()) {
  if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
  const path = join(dir, name);
  checked++;

  try {
    const doc = load(readFileSync(path, "utf8"));
    const jobs = Object.keys(doc?.jobs ?? {});
    if (jobs.length === 0) {
      console.error(`  FAIL ${name} — parses, but declares no jobs`);
      failures++;
      continue;
    }

    // A workflow that parses but was never wired to anything is as dead as one
    // that does not parse.
    const triggers = Object.keys(doc?.on ?? doc?.true ?? {});
    if (triggers.length === 0) {
      console.error(`  FAIL ${name} — has no trigger`);
      failures++;
      continue;
    }

    console.log(`  ok   ${name} — ${triggers.join(", ")} → ${jobs.join(", ")}`);
  } catch (err) {
    console.error(`  FAIL ${name} — ${String(err.message).split("\n")[0]}`);
    failures++;
  }
}

if (failures > 0) {
  console.error(`\n${failures} of ${checked} workflow(s) are invalid.`);
  process.exit(1);
}
console.log(`\n${checked} workflow(s) valid.`);
