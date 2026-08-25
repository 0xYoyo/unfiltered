/**
 * Render re-creation helper (YOY-115): moves the playground service's
 * configuration between Render services without a human ever handling a
 * secret. It talks to the Render REST API with RENDER_API_KEY and holds
 * every env var value in memory only — nothing here prints a value, and
 * the output of every command is safe to paste into a PR or an issue.
 *
 * Env loading is in-process (Node's built-in `process.loadEnvFile`), so no
 * `source .env` in the shell either; the file is read, never displayed.
 * Both `apps/shopify-app/.env` and the repo-root `.env` are tried; an
 * already-exported RENDER_API_KEY wins over either.
 *
 * Usage, from apps/shopify-app:
 *
 *   npx tsx scripts/render-migrate.mts preflight
 *     → "RENDER_API_KEY: present" or exit 1.
 *   npx tsx scripts/render-migrate.mts inspect <serviceId>
 *     → the service's settings (repo, branch, dockerfile path, health check
 *       path, plan, autoDeploy, region, URL) and its env var key NAMES.
 *   npx tsx scripts/render-migrate.mts create-group <serviceId> <groupName>
 *     → creates an environment group holding every env var of the service
 *       (same keys, same values), re-reads it, and confirms the key set
 *       matches. Refuses to run when a group of that name already exists.
 *   npx tsx scripts/render-migrate.mts link-group <groupName> <serviceId>
 *     → attaches an existing group to a (new) service — the step that runs
 *       after the Frankfurt service exists. Blueprint-created services get
 *       the link from render.yaml's `fromGroup`; this is the manual fallback.
 *
 * Stops (non-zero exit, no partial writes) on any 401/403/5xx from Render.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const RENDER_API = "https://api.render.com/v1";

// --- env ------------------------------------------------------------------

function loadEnvInProcess(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    resolve(here, "..", ".env"),
    resolve(here, "..", "..", "..", ".env"),
  ]) {
    try {
      process.loadEnvFile(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function requireApiKey(): string {
  const key = process.env.RENDER_API_KEY;
  if (!key) {
    console.error("RENDER_API_KEY: missing (checked the environment, apps/shopify-app/.env, and the repo-root .env)");
    process.exit(1);
  }
  return key;
}

// --- Render API -----------------------------------------------------------

type EnvVar = { key: string; value: string };

type ServiceSettings = {
  id: string;
  name: string;
  ownerId: string;
  repo: string;
  branch: string;
  autoDeploy: string;
  region: string;
  plan: string;
  healthCheckPath: string;
  dockerfilePath: string;
  dockerContext: string;
  url: string;
};

class RenderApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
  ) {
    super(`Render API ${method} ${path} → HTTP ${status}`);
  }
}

async function render<T>(
  apiKey: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${RENDER_API}${path}`, {
    method,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    // STOP conditions: auth failures and server errors abort the run. The
    // body is deliberately not echoed — Render error bodies can quote the
    // request payload.
    throw new RenderApiError(response.status, method, path);
  }
  return (await response.json()) as T;
}

/** Render list endpoints wrap each item as `{ <name>: item, cursor }`. */
type Cursored<K extends string, T> = Array<{ [P in K]: T } & { cursor: string }>;

async function listAll<K extends string, T>(
  apiKey: string,
  path: string,
  itemKey: K,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const separator = path.includes("?") ? "&" : "?";
    const page = await render<Cursored<K, T>>(
      apiKey,
      "GET",
      `${path}${separator}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    for (const row of page) items.push(row[itemKey]);
    if (page.length < 100) return items;
    cursor = page[page.length - 1]!.cursor;
  }
}

type RawService = {
  id: string;
  name: string;
  ownerId: string;
  repo?: string;
  branch?: string;
  autoDeploy?: string;
  serviceDetails?: {
    region?: string;
    plan?: string;
    healthCheckPath?: string;
    url?: string;
    envSpecificDetails?: { dockerfilePath?: string; dockerContext?: string };
  };
};

async function readService(
  apiKey: string,
  serviceId: string,
): Promise<ServiceSettings> {
  const raw = await render<RawService>(apiKey, "GET", `/services/${serviceId}`);
  const details = raw.serviceDetails ?? {};
  const docker = details.envSpecificDetails ?? {};
  return {
    id: raw.id,
    name: raw.name,
    ownerId: raw.ownerId,
    repo: raw.repo ?? "",
    branch: raw.branch ?? "",
    autoDeploy: raw.autoDeploy ?? "",
    region: details.region ?? "",
    plan: details.plan ?? "",
    healthCheckPath: details.healthCheckPath ?? "",
    dockerfilePath: docker.dockerfilePath ?? "",
    dockerContext: docker.dockerContext ?? "",
    url: details.url ?? "",
  };
}

function readServiceEnvVars(apiKey: string, serviceId: string): Promise<EnvVar[]> {
  return listAll<"envVar", EnvVar>(apiKey, `/services/${serviceId}/env-vars`, "envVar");
}

type EnvGroup = { id: string; name: string; envVars?: EnvVar[] };

async function findEnvGroup(
  apiKey: string,
  ownerId: string,
  name: string,
): Promise<EnvGroup | undefined> {
  const groups = await listAll<"envGroup", EnvGroup>(
    apiKey,
    `/env-groups?ownerId=${encodeURIComponent(ownerId)}`,
    "envGroup",
  );
  return groups.find((group) => group.name === name);
}

// --- output (names only, never values) ------------------------------------

function printSettings(settings: ServiceSettings): void {
  console.log("Service settings:");
  for (const [field, value] of Object.entries(settings)) {
    console.log(`  ${field.padEnd(16)} ${value}`);
  }
}

function printKeys(label: string, keys: string[]): void {
  console.log(`${label} (${keys.length}):`);
  for (const key of [...keys].sort()) console.log(`  ${key}`);
}

function sameKeySet(a: string[], b: string[]): boolean {
  const left = new Set(a);
  return left.size === new Set(b).size && b.every((key) => left.has(key));
}

// --- commands -------------------------------------------------------------

async function inspect(apiKey: string, serviceId: string): Promise<void> {
  const settings = await readService(apiKey, serviceId);
  const envVars = await readServiceEnvVars(apiKey, serviceId);
  printSettings(settings);
  printKeys("Env var keys", envVars.map((entry) => entry.key));
}

async function createGroup(
  apiKey: string,
  serviceId: string,
  groupName: string,
): Promise<void> {
  const settings = await readService(apiKey, serviceId);
  const envVars = await readServiceEnvVars(apiKey, serviceId);
  const serviceKeys = envVars.map((entry) => entry.key);

  const existing = await findEnvGroup(apiKey, settings.ownerId, groupName);
  if (existing) {
    console.error(`STOP: environment group "${groupName}" already exists (${existing.id}); nothing was written.`);
    process.exit(2);
  }

  const created = await render<EnvGroup>(apiKey, "POST", "/env-groups", {
    name: groupName,
    ownerId: settings.ownerId,
    envVars,
  });

  const reread = await render<EnvGroup>(apiKey, "GET", `/env-groups/${created.id}`);
  const groupKeys = (reread.envVars ?? []).map((entry) => entry.key);
  const valuesMatch = (reread.envVars ?? []).every(
    (entry) => envVars.find((source) => source.key === entry.key)?.value === entry.value,
  );

  printSettings(settings);
  printKeys("Service env var keys", serviceKeys);
  printKeys(`Group "${groupName}" (${created.id}) keys`, groupKeys);
  console.log(`Key sets equal: ${sameKeySet(serviceKeys, groupKeys) ? "yes" : "NO"}`);
  console.log(`Values match:   ${valuesMatch ? "yes" : "NO"}`);
  if (!sameKeySet(serviceKeys, groupKeys) || !valuesMatch) process.exit(3);
}

async function linkGroup(
  apiKey: string,
  groupName: string,
  serviceId: string,
): Promise<void> {
  const settings = await readService(apiKey, serviceId);
  const group = await findEnvGroup(apiKey, settings.ownerId, groupName);
  if (!group) {
    console.error(`STOP: environment group "${groupName}" not found for owner ${settings.ownerId}.`);
    process.exit(2);
  }
  await render(apiKey, "POST", `/env-groups/${group.id}/services/${serviceId}`);
  console.log(`Linked group "${groupName}" (${group.id}) → service ${settings.name} (${serviceId}).`);
}

// --- main -----------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);
const usage =
  "usage: render-migrate.mts preflight | inspect <serviceId> | create-group <serviceId> <groupName> | link-group <groupName> <serviceId>";

loadEnvInProcess();

try {
  switch (command) {
    case "preflight":
      requireApiKey();
      console.log("RENDER_API_KEY: present");
      break;
    case "inspect": {
      const [serviceId] = rest;
      if (!serviceId) throw new Error(usage);
      await inspect(requireApiKey(), serviceId);
      break;
    }
    case "create-group": {
      const [serviceId, groupName] = rest;
      if (!serviceId || !groupName) throw new Error(usage);
      await createGroup(requireApiKey(), serviceId, groupName);
      break;
    }
    case "link-group": {
      const [groupName, serviceId] = rest;
      if (!groupName || !serviceId) throw new Error(usage);
      await linkGroup(requireApiKey(), groupName, serviceId);
      break;
    }
    default:
      throw new Error(usage);
  }
} catch (error) {
  if (error instanceof RenderApiError) {
    console.error(`STOP: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
