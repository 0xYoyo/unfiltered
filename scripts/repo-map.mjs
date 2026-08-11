#!/usr/bin/env node
// repo-map.mjs — generates docs/REPO-MAP.md: a source tree, key locations,
// and a module-level import adjacency map. Zero dependencies by design.
//
// Seeded into product repos by /yoyo-init as scripts/repo-map.mjs. The
// committed map is GENERATED output: hand edits are forbidden and will be
// overwritten by the next run.
//
// Usage:
//   node scripts/repo-map.mjs            regenerate docs/REPO-MAP.md
//   node scripts/repo-map.mjs --check    CI drift guard: exit 1 when the
//                                        committed map differs from a fresh
//                                        generation, naming the fix command
//
// Env-file rule: this script lists env files by PATH ONLY and must never
// read env-file contents. The factory guard denies agent .env reads; the
// generator works under that guard by construction — readText() refuses
// env-like paths outright, so no code path can open one.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, posix } from "node:path";

const MAP_PATH = "docs/REPO-MAP.md";
const FIX_COMMAND = "node scripts/repo-map.mjs";

const ENV_FILE = /(^|\/)\.env(\.[^/]*)?$/;
const LOCKFILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock",
  "Cargo.lock", "poetry.lock", "uv.lock", "Gemfile.lock", "composer.lock",
]);
const EXCLUDED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt",
  "coverage", ".turbo", ".cache", "__pycache__", ".venv", "venv", "target",
]);

function isExcluded(path) {
  // The map never lists itself: it is tracked only after the first commit,
  // so including it would make the first post-commit --check always stale.
  if (path === MAP_PATH) return true;
  const parts = path.split("/");
  if (parts.some((part) => EXCLUDED_DIRS.has(part))) return true;
  if (LOCKFILES.has(parts[parts.length - 1])) return true;
  return false;
}

// The single file-reading gate. Every content read in this script goes
// through here, and env-like paths are refused: never read env-file contents.
function readText(path) {
  if (ENV_FILE.test(path.replace(/\\/g, "/"))) {
    throw new Error(`refusing to read env file contents: ${path}`);
  }
  return readFileSync(path, "utf8");
}

function listFiles() {
  // Tracked files keep the map deterministic between a dev machine and CI
  // (an untracked local .env can never leak into the tree). Outside a git
  // repository, fall back to a filesystem walk with the same exclusions.
  try {
    const output = execFileSync("git", ["ls-files"], { encoding: "utf8" });
    const files = output.split("\n").filter(Boolean).map((f) => posix.normalize(f));
    return { files: files.filter((f) => !isExcluded(f) && !ENV_FILE.test(f)), mode: "git" };
  } catch {
    const files = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const rel = dir === "." ? entry.name : `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (!EXCLUDED_DIRS.has(entry.name)) walk(rel);
        } else if (!isExcluded(rel)) {
          files.push(rel);
        }
      }
    };
    walk(".");
    return { files: files.filter((f) => !ENV_FILE.test(f)), mode: "walk" };
  }
}

// Env-file PATHS come from deterministic, tracked inputs only: tracked
// env-adjacent files (.env.example) and env-like entries declared in
// .gitignore. In walk mode (no git), on-disk env files are listed by path.
function envPaths(files, mode) {
  const paths = new Set();
  for (const file of files) {
    if (/(^|\/)\.env\.[^/]*(example|sample|template)[^/]*$/i.test(file)) paths.add(file);
  }
  if (existsSync(".gitignore")) {
    for (const line of readText(".gitignore").split("\n")) {
      const entry = line.trim();
      if (entry && !entry.startsWith("#") && ENV_FILE.test(entry.replace(/^\//, ""))) {
        paths.add(`${entry.replace(/^\//, "")} (declared in .gitignore)`);
      }
    }
  }
  if (mode === "walk") {
    const found = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = dir === "." ? entry.name : `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (!EXCLUDED_DIRS.has(entry.name)) walk(rel);
        } else if (ENV_FILE.test(rel)) {
          found.push(rel);
        }
      }
    };
    walk(".");
    for (const path of found.sort()) paths.add(path);
  }
  return [...paths].sort();
}

function renderTree(files) {
  const lines = [];
  const seenDirs = new Set();
  for (const file of [...files].sort()) {
    const parts = file.split("/");
    for (let depth = 0; depth < parts.length - 1; depth += 1) {
      const dir = parts.slice(0, depth + 1).join("/");
      if (!seenDirs.has(dir)) {
        seenDirs.add(dir);
        lines.push(`${"  ".repeat(depth)}${parts[depth]}/`);
      }
    }
    lines.push(`${"  ".repeat(parts.length - 1)}${parts[parts.length - 1]}`);
  }
  return lines.join("\n");
}

function keyLocations(files, mode) {
  const sections = [];
  const pick = (label, matcher) => {
    const hits = files.filter(matcher).sort();
    if (hits.length) sections.push(`- **${label}**: ${hits.join(", ")}`);
  };
  pick("Config files", (f) =>
    /(^|\/)(package\.json|tsconfig[^/]*\.json|pyproject\.toml|Cargo\.toml|Makefile|\.claude\/yoyo\.md|[^/]+\.config\.[cm]?[jt]s|\.github\/workflows\/[^/]+)$/.test(f));
  const env = envPaths(files, mode);
  sections.push(env.length
    ? `- **Env files (paths only — contents never read)**: ${env.join(", ")}`
    : "- **Env files**: none declared");
  pick("Entrypoints", (f) =>
    /(^|\/)(src\/)?(index|main|app|cli|server)\.[cm]?[jt]sx?$|(^|\/)(main|app|manage)\.py$|(^|\/)src\/main\.rs$/.test(f));
  pick("Scripts", (f) => /^scripts\//.test(f) || /(^|\/)bin\//.test(f));
  pick("Fixtures", (f) => /(^|\/)(__)?fixtures(__)?\//.test(f));
  pick("Migrations", (f) => /(^|\/)migrations\//.test(f));
  return sections.join("\n");
}

function importGraph(files) {
  const modules = files.filter((f) => /\.[cm]?[jt]sx?$/.test(f));
  if (!modules.length) {
    return "No module graph: no JavaScript/TypeScript modules detected, so the static import/require scan has nothing to map. This section is intentionally absent, not stale.";
  }
  const moduleSet = new Set(modules);
  const resolve = (fromFile, specifier) => {
    if (!specifier.startsWith(".")) return null; // external package — out of scope
    const base = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
    const candidates = [base, ...["js", "mjs", "cjs", "ts", "tsx", "jsx"].map((ext) => `${base}.${ext}`),
      ...["js", "mjs", "cjs", "ts", "tsx", "jsx"].map((ext) => `${base}/index.${ext}`)];
    return candidates.find((candidate) => moduleSet.has(candidate)) ?? `${base} (unresolved)`;
  };
  const lines = [];
  for (const file of [...modules].sort()) {
    const source = readText(file);
    const targets = new Set();
    const patterns = [
      /import\s+(?:[\s\S]*?from\s+)?["']([^"']+)["']/g,
      /require\(\s*["']([^"']+)["']\s*\)/g,
      /import\(\s*["']([^"']+)["']\s*\)/g,
    ];
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        const resolved = resolve(file, match[1]);
        if (resolved) targets.add(resolved);
      }
    }
    if (targets.size) lines.push(`- ${file} → ${[...targets].sort().join(", ")}`);
  }
  return lines.length
    ? lines.join("\n")
    : "No internal imports found: modules exist but none imports another repository module.";
}

function generate() {
  const { files, mode } = listFiles();
  return `# Repo map

<!-- GENERATED by \`${FIX_COMMAND}\` — do not edit by hand. Hand edits are
forbidden and will be overwritten; the CI drift guard fails when this file
does not match a fresh generation. -->

## Source tree

\`\`\`
${renderTree(files)}
\`\`\`

## Key locations

${keyLocations(files, mode)}

## Module dependency map

${importGraph(files)}
`;
}

const fresh = generate();

if (process.argv.includes("--check")) {
  const committed = existsSync(MAP_PATH) ? readText(MAP_PATH) : null;
  if (committed !== fresh) {
    console.error(
      `${MAP_PATH} is stale (or missing): the repository layout changed but the map was not regenerated.\n` +
      `Fix: run \`${FIX_COMMAND}\` and commit the result.`,
    );
    process.exit(1);
  }
  console.log(`${MAP_PATH} is up to date.`);
} else {
  mkdirSync(dirname(MAP_PATH), { recursive: true });
  writeFileSync(MAP_PATH, fresh);
  console.log(`Wrote ${MAP_PATH}.`);
}
