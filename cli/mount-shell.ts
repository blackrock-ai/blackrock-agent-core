import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

type Config = {
  TARGET_REPO: string;
  TARGET_WEB_DIR: string;
  TENANT_SLUG: string;
  TENANT_DISPLAY_NAME?: string;
};

function parseConfig(path: string): Config {
  const raw = readFileSync(path, "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }

  const required = ["TARGET_REPO", "TARGET_WEB_DIR", "TENANT_SLUG"] as const;
  for (const key of required) {
    if (!out[key]) {
      throw new Error(`Missing ${key} in ${path}`);
    }
  }

  return out as unknown as Config;
}

function titleCaseSlug(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function parseArgs(argv: string[]) {
  const scriptDir = resolve(__dirname);
  const defaults = {
    config: resolve(scriptDir, "install.config"),
    dryRun: false,
    writeSnippet: true,
  };

  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (!arg) break;
    if (arg === "--dry-run") {
      defaults.dryRun = true;
      continue;
    }
    if (arg === "--config") {
      const value = args.shift();
      if (!value) throw new Error("--config requires a path");
      defaults.config = resolve(value);
      continue;
    }
    if (arg === "--no-snippet-file") {
      defaults.writeSnippet = false;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return defaults;
}

function buildAgentConfig(tenantSlug: string, displayName: string): string {
  const identifier = tenantSlug.replace(/[^a-zA-Z0-9_$]/g, "_");
  return `import { Home } from "lucide-react";
import type { TenantConfig } from "@blackrock-ai/agent-core";

export const ${identifier}Config: TenantConfig = {
  id: "${tenantSlug}",
  brand: "${displayName}",
  product: "${displayName} Workspace",
  tagline: "AI workspace",
  accent: "#1F6FEB",
  nav: [{ id: "home", label: "Home", Icon: Home }],
  categories: [],
};

export const tenantConfig = ${identifier}Config;
`;
}

function buildMountSnippet(): string {
  return `// In your top-level route (e.g. app/page.tsx for Next.js App Router, or src/App.tsx for Vite):
import { Workspace } from "@blackrock-ai/agent-core";
import { tenantConfig } from "./agent.config";

export default function Page() {
  return <Workspace config={tenantConfig} />;
}
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = parseConfig(args.config);
  const tenantDisplayName = config.TENANT_DISPLAY_NAME ?? titleCaseSlug(config.TENANT_SLUG);

  const targetConfigPath = resolve(config.TARGET_REPO, config.TARGET_WEB_DIR, "agent.config.ts");
  const snippet = buildMountSnippet();
  const agentConfig = buildAgentConfig(config.TENANT_SLUG, tenantDisplayName);
  const snippetPath = resolve(config.TARGET_REPO, ".agent-core-install", "MOUNT_SNIPPET.md");

  if (args.dryRun) {
    console.log(`[dry-run] would write ${targetConfigPath}`);
    console.log(agentConfig);
    console.log("[dry-run] mount snippet:");
    console.log(snippet);
    if (args.writeSnippet) {
      console.log(`[dry-run] would write ${snippetPath}`);
    }
    console.log("Manual action required: place the mount snippet in your host route file (Next App Router/Pages, Vite, CRA, Remix, etc.). This script does not auto-edit routing files.");
    return;
  }

  mkdirSync(dirname(targetConfigPath), { recursive: true });
  writeFileSync(targetConfigPath, agentConfig, "utf8");

  if (args.writeSnippet) {
    mkdirSync(dirname(snippetPath), { recursive: true });
    writeFileSync(snippetPath, snippet, "utf8");
  }

  console.log(`Wrote ${targetConfigPath}`);
  console.log("Mount snippet:");
  console.log(snippet);
  if (args.writeSnippet) {
    console.log(`Wrote ${snippetPath}`);
  }
  console.log("Manual action required: place the mount snippet in your host route file (Next App Router/Pages, Vite, CRA, Remix, etc.). This script does not auto-edit routing files.");
}

main();
