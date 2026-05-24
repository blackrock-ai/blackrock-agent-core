import { describe, expect, test } from "bun:test";
import { parseVersionsFromOutput, planRenames } from "../prepare-migrations";

const sourceFiles = [
  "0001_agent_core.sql",
  "0002_credential_resolution.sql",
  "0003_artifacts_storage.sql",
  "0004_read_only_query_path.sql",
  "0005_run_lifecycle.sql",
  "0006_oauth_connections.sql",
];

describe("parseVersionsFromOutput", () => {
  test("returns [] for header + (0 rows) footer", () => {
    const output = `
 version
---------

(0 rows)
`;
    expect(parseVersionsFromOutput(output)).toEqual([]);
  });

  test("returns versions and ignores (3 rows) footer", () => {
    const output = `
 version
---------
 20260501010101
 20260502020202
 20260503030303
(3 rows)
`;
    expect(parseVersionsFromOutput(output)).toEqual([
      "20260501010101",
      "20260502020202",
      "20260503030303",
    ]);
  });

  test("parses supabase-style table output", () => {
    const output = `
  version
----------------
  0001
  0002
  0003
(3 rows)
`;
    expect(parseVersionsFromOutput(output)).toEqual(["0001", "0002", "0003"]);
  });
});

describe("planRenames", () => {
  test("sequential with live max 28", () => {
    const plan = planRenames(sourceFiles, ["0001", "0028"], "sequential");
    expect(plan.map((p) => p.to)).toEqual([
      "0029_agent_core.sql",
      "0030_credential_resolution.sql",
      "0031_artifacts_storage.sql",
      "0032_read_only_query_path.sql",
      "0033_run_lifecycle.sql",
      "0034_oauth_connections.sql",
    ]);
  });

  test("sequential with empty live state", () => {
    const plan = planRenames(sourceFiles, [], "sequential");
    expect(plan.map((p) => p.to)).toEqual([
      "0001_agent_core.sql",
      "0002_credential_resolution.sql",
      "0003_artifacts_storage.sql",
      "0004_read_only_query_path.sql",
      "0005_run_lifecycle.sql",
      "0006_oauth_connections.sql",
    ]);
  });

  test("sequential ignores non-numeric live versions", () => {
    const plan = planRenames(sourceFiles, ["legacy_migration"], "sequential");
    expect(plan[0]?.to).toBe("0001_agent_core.sql");
  });

  test("supabase timestamp uses live max when greater than seed timestamp", () => {
    // 20260524235959 is the last valid second of 2026-05-24 UTC. The next
    // migration must start at 20260525000000 (midnight), proving the planner
    // uses real date arithmetic — NOT decimal increment (which would
    // wrongly yield 20260524235960, an invalid timestamp).
    const plan = planRenames(sourceFiles, ["20260524235959"], "supabase_timestamp", 1748000000000);
    expect(plan[0]?.to).toBe("20260525000000_agent_core.sql");
    expect(plan[1]?.to).toBe("20260525000001_credential_resolution.sql");
  });

  test("supabase timestamp ignores invalid 14-digit strings that don't parse as real UTC", () => {
    // 99:99:99 is shape-matched by /^\d{14}$/ but is not a valid UTC datetime.
    // JavaScript's Date.UTC() would lenient-normalize it (rolling hours into
    // days), so the parser does an explicit round-trip check and returns null.
    // The planner must then ignore that live version and fall back to the seed.
    // Seed 1748000000000ms = 2025-05-23T11:33:20Z = formatUtcTimestamp -> 20250523113320.
    const plan = planRenames(sourceFiles, ["20260524999999"], "supabase_timestamp", 1748000000000);
    expect(plan[0]?.to).toBe("20250523113320_agent_core.sql");
  });

  test("supabase timestamp rejects Feb 30 (day-of-month overflow)", () => {
    // Date.UTC(2026, 1, 30) rolls forward to Mar 2 silently. The round-trip
    // check inside parseUtcTimestampToEpoch must catch this and return null.
    const plan = planRenames(sourceFiles, ["20260230120000"], "supabase_timestamp", 1748000000000);
    // Live version is rejected, so seed is used.
    expect(plan[0]?.to).toBe("20250523113320_agent_core.sql");
  });

  test("supabase timestamp uses seed when no numeric live versions", () => {
    const plan = planRenames(sourceFiles, ["legacy_migration"], "supabase_timestamp", 1748103534000);
    const timestamps = plan.map((p) => Number.parseInt(p.to.slice(0, 14), 10));
    expect(timestamps.length).toBe(6);
    expect(timestamps[0]).toBe(20250524161854);
    for (let i = 1; i < timestamps.length; i += 1) {
      expect(timestamps[i]).toBe(timestamps[i - 1] + 1);
    }
  });

  test("sequential with gapped live state starts at max+1", () => {
    const plan = planRenames(sourceFiles, ["1", "2", "5", "7"], "sequential");
    expect(plan[0]?.to).toBe("0008_agent_core.sql");
  });
});
