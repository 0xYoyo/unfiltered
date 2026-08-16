/**
 * Install the theme-native rendering alternate product template (YOY-70
 * AC-1) on a store's theme — the config-driven, no-hand-editing form of the
 * Klevu/Relewise "alternate template" prior art.
 *
 * Generates `templates/product.<view>.liquid` from
 * `widget/src/native-render.config.ts` (the same object the widget bundle
 * reads, so view name and snippet cannot drift) and pushes ONLY that file
 * with the Shopify CLI (`theme push --only`, `--nodelete`): every other theme
 * file is left untouched. Additive and inert — nothing on the storefront
 * changes until a request carries `?view=<view>`, and the widget only sends
 * that behind its dev flag.
 *
 * Usage, from apps/shopify-app (CLI login via `shopify auth login` first):
 *
 *   npx tsx scripts/native-render-template.mts --theme 141835272267
 *   npx tsx scripts/native-render-template.mts --theme <id> --store x.myshopify.com
 *   npx tsx scripts/native-render-template.mts --print          # source only
 *
 * `--allow-live` is passed through when the target is the live theme, which
 * is what the dev-store spike needs; a production rollout is M6 work.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  alternateTemplateSource,
  resolveNativeRenderConfig,
} from "../widget/src/native-render.config";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};

const config = resolveNativeRenderConfig();
const fileName = `templates/product.${config.template.view}.liquid`;
const source = alternateTemplateSource(config.template);

if (args.includes("--print")) {
  process.stdout.write(`# ${fileName}\n${source}`);
  process.exit(0);
}

const theme = flag("theme");
if (theme === undefined) {
  console.error("usage: --theme <id> [--store <domain>] | --print");
  process.exit(2);
}
const store = flag("store") ?? "unfiltered-dev.myshopify.com";

// A sparse theme directory holding only the alternate template; `--only`
// scopes the push to it and `--nodelete` guarantees nothing else moves.
const dir = mkdtempSync(join(tmpdir(), "unfiltered-alt-template-"));
mkdirSync(join(dir, "templates"));
writeFileSync(join(dir, fileName), source);
console.log(`generated ${fileName}:\n${source}`);

const result = spawnSync(
  "npx",
  [
    "shopify",
    "theme",
    "push",
    "--path",
    dir,
    "--theme",
    theme,
    "--store",
    store,
    "--only",
    fileName,
    "--nodelete",
    "--allow-live",
  ],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
