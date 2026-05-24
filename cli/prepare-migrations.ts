import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

type Style = "sequential" | "supabase_timestamp";

type RenamePlan = {
  from: string;
  to: string;
};

type CliArgs = {
  style: Style;
  sourceDir: string;
  targetDir: string;
  out?: string;
  dryRun: boolean;
  sourceFiles?: string[];
  liveVersionsOverride?: string[];
  appliedSourceBasenames?: Set<string>;
  timestampSeed?: number;
};

const PREFIX_REGEX = /^(\d+)_/;

export function planRenames(
  sourceFiles: string[],
  liveVersions: string[],
  style: Style,
  timestampSeed?: number,
): RenamePlan[] {
  const orderedSources = [...sourceFiles]
    .filter((file) => file.endsWith(".sql") && PREFIX_REGEX.test(file))
    .sort((a, b) => {
      const aNum = Number((a.match(PREFIX_REGEX) ?? ["", "0"])[1]);
      const bNum = Number((b.match(PREFIX_REGEX) ?? ["", "0"])[1]);
      return aNum - bNum;
    });

  if (style === "sequential") {
    const liveMax = liveVersions
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isFinite(value))
      .reduce((max, value) => Math.max(max, value), 0);

    return orderedSources.map((from, idx) => {
      const suffix = from.replace(PREFIX_REGEX, "");
      const next = String(liveMax + idx + 1).padStart(4, "0");
      return { from, to: `${next}_${suffix}` };
    });
  }

  // Build candidate seeds in EPOCH SECONDS (not as decimal-mashed YYYYMMDDHHMMSS
  // integers — adding 1 to 20260524235959 would otherwise produce the invalid
  // value 20260524235960). We compute both candidates as epoch seconds and pick
  // whichever is larger, then format with proper date arithmetic.
  const seedEpoch = Math.floor((timestampSeed ?? Date.now()) / 1000);
  const liveMaxEpoch = liveVersions
    .map((value) => value.trim())
    .filter((value) => /^\d{14}$/.test(value))
    .map((value) => parseUtcTimestampToEpoch(value))
    .filter((value): value is number => value !== null)
    .reduce((max, value) => Math.max(max, value), 0);
  const startEpoch = Math.max(seedEpoch, liveMaxEpoch + 1);

  return orderedSources.map((from, idx) => {
    const suffix = from.replace(PREFIX_REGEX, "");
    const timestamp = formatUtcTimestamp(startEpoch + idx);
    return { from, to: `${timestamp}_${suffix}` };
  });
}

function parseUtcTimestampToEpoch(value: string): number | null {
  // value is YYYYMMDDHHMMSS, UTC. Return epoch seconds or null if any
  // component is out-of-range. We round-trip every component because
  // Date.UTC() normalizes (e.g., hour=99 becomes hour=3 + 4 added days)
  // rather than returning NaN — so a shape-valid string with bogus
  // components must be detected by comparing the parsed Date back to
  // the inputs.
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value);
  if (!m) return null;
  const yIn = Number(m[1]);
  const moIn = Number(m[2]);
  const dIn = Number(m[3]);
  const hIn = Number(m[4]);
  const miIn = Number(m[5]);
  const sIn = Number(m[6]);
  // Quick bounds check before delegating to Date.
  if (moIn < 1 || moIn > 12) return null;
  if (dIn < 1 || dIn > 31) return null;
  if (hIn > 23) return null;
  if (miIn > 59) return null;
  if (sIn > 59) return null;
  const ms = Date.UTC(yIn, moIn - 1, dIn, hIn, miIn, sIn);
  if (Number.isNaN(ms)) return null;
  // Round-trip: catch DOY normalization (e.g., Feb 30 → Mar 2).
  const d = new Date(ms);
  if (
    d.getUTCFullYear() !== yIn ||
    d.getUTCMonth() !== moIn - 1 ||
    d.getUTCDate() !== dIn ||
    d.getUTCHours() !== hIn ||
    d.getUTCMinutes() !== miIn ||
    d.getUTCSeconds() !== sIn
  ) {
    return null;
  }
  return Math.floor(ms / 1000);
}

function formatUtcTimestamp(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}${hh}${mi}${ss}`;
}

function parseArgs(argv: string[]): CliArgs {
  const rootDir = resolve(__dirname, "..");
  const defaults: CliArgs = {
    style: "sequential",
    sourceDir: resolve(rootDir, "packages/schema/migrations"),
    targetDir: resolve(process.env.TARGET_REPO ?? "", "supabase/migrations"),
    dryRun: false,
  };

  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (!arg) break;
    if (arg === "--dry-run") {
      defaults.dryRun = true;
      continue;
    }
    if (arg === "--style") {
      const style = args.shift() as Style | undefined;
      if (style !== "sequential" && style !== "supabase_timestamp") {
        throw new Error("--style must be sequential or supabase_timestamp");
      }
      defaults.style = style;
      continue;
    }
    if (arg === "--source-dir") {
      const value = args.shift();
      if (!value) throw new Error("--source-dir requires a value");
      defaults.sourceDir = resolve(value);
      continue;
    }
    if (arg === "--target-dir") {
      const value = args.shift();
      if (!value) throw new Error("--target-dir requires a value");
      defaults.targetDir = resolve(value);
      continue;
    }
    if (arg === "--out") {
      const value = args.shift();
      if (!value) throw new Error("--out requires a value");
      defaults.out = resolve(value);
      continue;
    }
    if (arg === "--source-files") {
      const value = args.shift();
      if (!value) throw new Error("--source-files requires a value");
      defaults.sourceFiles = value
        .split(",")
        .map((file) => file.trim())
        .filter(Boolean);
      continue;
    }
    if (arg === "--live-versions") {
      const value = args.shift();
      if (!value) throw new Error("--live-versions requires a value");
      defaults.liveVersionsOverride = value
        .split(",")
        .map((version) => version.trim())
        .filter(Boolean);
      continue;
    }
    if (arg === "--timestamp-seed") {
      const value = args.shift();
      if (!value) throw new Error("--timestamp-seed requires a value");
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed)) {
        throw new Error("--timestamp-seed must be an integer epoch milliseconds");
      }
      defaults.timestampSeed = parsed;
      continue;
    }
    if (arg === "--applied" || arg === "--applied-source-basenames") {
      const value = args.shift();
      if (!value) throw new Error(`${arg} requires a value`);
      const splitValues = value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean);
      defaults.appliedSourceBasenames ??= new Set<string>();
      for (const basename of splitValues) {
        defaults.appliedSourceBasenames.add(basename);
      }
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!defaults.targetDir) {
    throw new Error("--target-dir is required when TARGET_REPO is not set");
  }

  return defaults;
}

export function parseVersionsFromOutput(output: string): string[] {
  const lines = output.split(/\r?\n/);
  const versions: string[] = [];

  let headerIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const normalized = lines[i]?.replace(/[|│]/g, " ").trim().toLowerCase() ?? "";
    if (normalized && normalized.split(/\s+/).includes("version")) {
      headerIndex = i;
      break;
    }
  }

  if (headerIndex === -1) {
    return [];
  }

  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    const line = raw.trim();

    if (!line) {
      break;
    }
    if (/^[-+|\s]*$/u.test(line)) {
      continue;
    }
    if (/^\(\d+\s+rows?\)$/i.test(line)) {
      break;
    }
    if (/^(timing|error|failed)/i.test(line)) {
      break;
    }

    const firstToken = line.replace(/[|│]/g, " ").trim().split(/\s+/)[0] ?? "";
    if (!firstToken || /^\(\d+\s+rows?\)$/i.test(firstToken)) {
      continue;
    }

    versions.push(firstToken);
  }

  return versions;
}

function runSupabaseQuery(args: string[]): { ok: boolean; output: string; error: string } {
  const result = spawnSync("supabase", args, { encoding: "utf8" });
  return {
    ok: result.status === 0,
    output: result.stdout ?? "",
    error: result.stderr ?? "",
  };
}

async function fetchLiveVersions(): Promise<string[]> {
  const projectRef = process.env.SUPABASE_PROJECT_REF;
  if (!projectRef) {
    throw new Error("SUPABASE_PROJECT_REF is required");
  }

  const query = "select version from supabase_migrations.schema_migrations order by version;";
  const attempts: string[][] = [
    ["db", "remote", "query", query, "--project-ref", projectRef],
    ["db", "query", query, "--project-ref", projectRef],
    ["db", "query", query],
  ];

  const errors: string[] = [];
  for (const args of attempts) {
    const result = runSupabaseQuery(args);
    if (!result.ok) {
      errors.push(`${args.join(" ")}: ${result.error.trim() || result.output.trim()}`);
      continue;
    }

    return parseVersionsFromOutput(result.output);
  }

  throw new Error(`Failed to fetch live migration state via Supabase CLI. ${errors.join(" | ")}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const sourceFiles = (args.sourceFiles && args.sourceFiles.length > 0
    ? args.sourceFiles
    : readdirSync(args.sourceDir).filter((file) => file.endsWith(".sql"))
  )
    .filter((file) => !args.appliedSourceBasenames?.has(file))
    .sort((a, b) => {
      const aNum = Number((a.match(PREFIX_REGEX) ?? ["", "0"])[1]);
      const bNum = Number((b.match(PREFIX_REGEX) ?? ["", "0"])[1]);
      return aNum - bNum;
    });

  let liveVersions: string[] = [];
  let unreconciled = false;

  if (args.liveVersionsOverride) {
    liveVersions = args.liveVersionsOverride;
  } else {
    try {
      liveVersions = await fetchLiveVersions();
    } catch (error) {
      if (!args.dryRun) {
        throw error;
      }
      unreconciled = true;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`WARNING: ${message}`);
      console.warn("WARNING: proceeding with empty live migration state for dry-run only.");
      liveVersions = [];
    }
  }

  const plan = planRenames(sourceFiles, liveVersions, args.style, args.timestampSeed);

  const summary = {
    style: args.style,
    sourceDir: args.sourceDir,
    targetDir: args.targetDir,
    liveCount: liveVersions.length,
    liveVersions,
    unreconciled,
    mappings: plan,
  };

  console.log("LIVE MIGRATION STATE:");
  console.log(`count=${liveVersions.length}`);
  if (liveVersions.length > 0) {
    console.log(liveVersions.join(", "));
  }
  if (unreconciled) {
    console.log("(unreconciled — live state fetch failed)");
  }

  console.log("MIGRATION MANIFEST:");
  for (const item of plan) {
    console.log(`${item.from} -> ${item.to}`);
    if (!args.dryRun) {
      mkdirSync(args.targetDir, { recursive: true });
      const content = readFileSync(join(args.sourceDir, item.from), "utf8");
      writeFileSync(join(args.targetDir, item.to), content, "utf8");
    }
  }

  if (args.out) {
    if (!args.dryRun) {
      mkdirSync(dirname(args.out), { recursive: true });
      writeFileSync(args.out, JSON.stringify(summary, null, 2), "utf8");
    } else {
      console.log(`(dry-run) would write manifest JSON to ${args.out}`);
    }
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
