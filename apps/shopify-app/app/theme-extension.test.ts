import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The widget block's schema translations (YOY-157 AC-22). Theme check
 * (ValidSchemaTranslations) fails the extension when a schema value `t:key`
 * has no `key` in `locales/en.default.schema.json`; theme check is not in CI,
 * so this guards the same rule: every `t:` reference in a block schema
 * resolves in the default schema locale, and every other schema locale
 * carries the same keys.
 */

const EXTENSION = fileURLToPath(new URL("../extensions/unfiltered-widget", import.meta.url));

function schemaOf(liquid: string): unknown {
  const match = /{%\s*schema\s*%}([\s\S]*?){%\s*endschema\s*%}/.exec(liquid);
  return match === null ? {} : JSON.parse(match[1]!);
}

function translationKeys(value: unknown): string[] {
  if (typeof value === "string") return value.startsWith("t:") ? [value.slice(2)] : [];
  if (Array.isArray(value)) return value.flatMap(translationKeys);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(translationKeys);
  return [];
}

function lookup(locale: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>(
    (node, part) => (node !== null && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined),
    locale,
  );
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

describe("theme app extension schema translations (YOY-157 AC-22)", () => {
  const blocks = readdirSync(join(EXTENSION, "blocks")).filter((file) => file.endsWith(".liquid"));
  const keys = blocks.flatMap((file) =>
    translationKeys(schemaOf(readFileSync(join(EXTENSION, "blocks", file), "utf8"))),
  );
  const schemaLocales = readdirSync(join(EXTENSION, "locales")).filter((file) => file.endsWith(".schema.json"));

  it("finds the block's translated name", () => {
    expect(keys).toContain("name");
  });

  it("resolves every t: key in en.default.schema.json and in each other schema locale", () => {
    expect(schemaLocales).toContain("en.default.schema.json");
    for (const file of schemaLocales) {
      const locale = readJson(join(EXTENSION, "locales", file));
      for (const key of keys) {
        expect(typeof lookup(locale, key), `${file} → ${key}`).toBe("string");
      }
    }
  });
});
