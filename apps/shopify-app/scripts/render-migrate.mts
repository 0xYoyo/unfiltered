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
 *   npx tsx scripts/render-migrate.mts create-service <oldServiceId> <name> <region>
 *     → creates a new Docker web service with the old service's repo,
 *       branch, autoDeploy, dockerfilePath, dockerContext, healthCheckPath
 *       and plan, in <region>. Prints the new service's settings and the
 *       id of the deploy Render started for it (if any). Env vars are NOT
 *       copied — link the group with link-group afterwards.
 *   npx tsx scripts/render-migrate.mts deploys <serviceId>
 *     → the ten most recent deploys with status, trigger and timestamps.
 *   npx tsx scripts/render-migrate.mts trigger-deploy <serviceId>
 *     → starts a build-and-deploy and prints its id.
 *   npx tsx scripts/render-migrate.mts wait-deploy <serviceId> [deployId] [timeoutMinutes]
 *     → polls the deploy (latest one when no id is given) until it is live
 *       or failed; exits non-zero on failure or after the timeout (15 min).
 *   npx tsx scripts/render-migrate.mts set-group-var <groupName> <key> <value>
 *     → sets one variable in an environment group (for non-secret values
 *       such as SHOPIFY_APP_URL). Prints the key name only, never the value.
 *   npx tsx scripts/render-migrate.mts pool-database-url <groupName>
 *     → switches the group to Neon's pooled connection (YOY-115 AC-5):
 *       reads DATABASE_URL from the group in-process, writes
 *       DIRECT_DATABASE_URL = that value (the direct host, for migrations),
 *       and rewrites DATABASE_URL with `-pooler` inserted after the Neon
 *       endpoint id in the host plus `pgbouncer=true` (keeping
 *       `sslmode=require`). Prints key names only. Refuses when
 *       DATABASE_URL already contains `-pooler`. Follow with trigger-deploy.
 *
 * Stops (non-zero exit, no partial writes) on any 401/403/5xx from Render.
 */

import { fileURLToPath, pathToFileURL } from "node:url";
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
    detail?: string,
  ) {
    super(`Render API ${method} ${path} → HTTP ${status}${detail ? ` (${detail})` : ""}`);
  }
}

async function render<T>(
  apiKey: string,
  method: "GET" | "POST" | "PUT",
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
    // STOP conditions: auth failures and server errors abort the run. Only
    // Render's short `message` field is surfaced — the full body is never
    // echoed because it can quote the request payload.
    let detail: string | undefined;
    try {
      const body = (await response.json()) as { message?: unknown };
      if (typeof body.message === "string") detail = body.message;
    } catch {
      /* no JSON body */
    }
    throw new RenderApiError(response.status, method, path, detail);
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

type EnvGroup = {
  id: string;
  name: string;
  envVars?: EnvVar[];
  serviceLinks?: Array<{ id: string; name?: string }>;
};

/** Env groups attached to a service, with their variables (list rows omit
 *  envVars, so each linked group is re-read individually). */
async function linkedEnvGroups(
  apiKey: string,
  ownerId: string,
  serviceId: string,
): Promise<EnvGroup[]> {
  const groups = await listAll<"envGroup", EnvGroup>(
    apiKey,
    `/env-groups?ownerId=${encodeURIComponent(ownerId)}`,
    "envGroup",
  );
  const linked: EnvGroup[] = [];
  for (const group of groups) {
    const full = await render<EnvGroup>(apiKey, "GET", `/env-groups/${group.id}`);
    if ((full.serviceLinks ?? []).some((link) => link.id === serviceId)) linked.push(full);
  }
  return linked;
}

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

type Deploy = {
  id: string;
  status: string;
  trigger?: string;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
};

const DEPLOY_FAILED = new Set([
  "build_failed",
  "update_failed",
  "pre_deploy_failed",
  "canceled",
  "deactivated",
]);

async function latestDeploy(apiKey: string, serviceId: string): Promise<Deploy | undefined> {
  const page = await render<Cursored<"deploy", Deploy>>(
    apiKey,
    "GET",
    `/services/${serviceId}/deploys?limit=1`,
  );
  return page[0]?.deploy;
}

function readDeploy(apiKey: string, serviceId: string, deployId: string): Promise<Deploy> {
  return render<Deploy>(apiKey, "GET", `/services/${serviceId}/deploys/${deployId}`);
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

// --- pooled URL rewrite (pure; unit-tested) ---------------------------------

export class PoolUrlError extends Error {}

/**
 * Rewrite a Neon direct connection string into its pooled twin (YOY-115
 * AC-5): the host `ep-<name>-<id>.<region>.aws.neon.tech` becomes
 * `ep-<name>-<id>-pooler.<region>.aws.neon.tech`, and `pgbouncer=true` is
 * added so Prisma speaks PgBouncer's transaction mode. Every other part of
 * the URL — user, password, database, `sslmode=require`, any other
 * parameter — is kept verbatim. Refuses a URL that is already pooled and a
 * URL whose host is not a Neon endpoint, so a mistaken group never gets a
 * nonsense host written into it.
 */
export function poolDatabaseUrl(directUrl: string): string {
  let url: URL;
  try {
    url = new URL(directUrl);
  } catch {
    throw new PoolUrlError("DATABASE_URL is not a valid URL");
  }
  if (url.hostname.includes("-pooler")) {
    throw new PoolUrlError("DATABASE_URL already uses the pooled (-pooler) host");
  }
  const match = /^(ep-[a-z0-9-]+?-[a-z0-9]+)(\..+)$/.exec(url.hostname);
  if (match === null || !url.hostname.endsWith(".neon.tech")) {
    throw new PoolUrlError(
      `DATABASE_URL host is not a Neon endpoint (ep-<name>-<id>.<region>.aws.neon.tech): ${url.hostname}`,
    );
  }
  url.hostname = `${match[1]}-pooler${match[2]}`;
  if (url.searchParams.get("pgbouncer") !== "true") {
    url.searchParams.set("pgbouncer", "true");
  }
  return url.toString();
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
  printKeys("Service-level env var keys", envVars.map((entry) => entry.key));
  for (const group of await linkedEnvGroups(apiKey, settings.ownerId, settings.id)) {
    printKeys(
      `Linked group "${group.name}" (${group.id}) keys`,
      (group.envVars ?? []).map((entry) => entry.key),
    );
  }
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

async function createService(
  apiKey: string,
  oldServiceId: string,
  name: string,
  region: string,
): Promise<void> {
  const source = await readService(apiKey, oldServiceId);
  // Payload per https://api-docs.render.com/reference/create-service —
  // Docker web service; no envVars (the group is linked afterwards).
  const created = await render<{ service: RawService; deployId?: string }>(
    apiKey,
    "POST",
    "/services",
    {
      type: "web_service",
      name,
      ownerId: source.ownerId,
      repo: source.repo,
      branch: source.branch,
      autoDeploy: source.autoDeploy || "yes",
      serviceDetails: {
        runtime: "docker",
        region,
        plan: source.plan || "free",
        healthCheckPath: source.healthCheckPath,
        envSpecificDetails: {
          dockerfilePath: source.dockerfilePath || "./Dockerfile",
          dockerContext: source.dockerContext || ".",
        },
      },
    },
  );
  const settings = await readService(apiKey, created.service.id);
  printSettings(settings);
  console.log(`Initial deploy: ${created.deployId ?? "(none started)"}`);
}

async function listDeploys(apiKey: string, serviceId: string): Promise<void> {
  const page = await render<Cursored<"deploy", Deploy>>(
    apiKey,
    "GET",
    `/services/${serviceId}/deploys?limit=10`,
  );
  console.log(`Deploys for ${serviceId} (newest first):`);
  for (const { deploy } of page) {
    console.log(
      `  ${deploy.id}  ${deploy.status.padEnd(20)} trigger=${deploy.trigger ?? "?"}  created=${deploy.createdAt ?? "?"}  finished=${deploy.finishedAt ?? "-"}`,
    );
  }
}

async function triggerDeploy(apiKey: string, serviceId: string): Promise<void> {
  const deploy = await render<Deploy>(apiKey, "POST", `/services/${serviceId}/deploys`, {
    clearCache: "do_not_clear",
  });
  console.log(`Deploy ${deploy.id} started (${deploy.status}) at ${deploy.createdAt ?? "?"}`);
}

async function waitDeploy(
  apiKey: string,
  serviceId: string,
  deployId: string | undefined,
  timeoutMinutes: number,
): Promise<void> {
  let id = deployId;
  if (!id) {
    const latest = await latestDeploy(apiKey, serviceId);
    if (!latest) {
      console.error(`STOP: service ${serviceId} has no deploys.`);
      process.exit(2);
    }
    id = latest.id;
  }
  const deadline = Date.now() + timeoutMinutes * 60_000;
  let last = "";
  for (;;) {
    const deploy = await readDeploy(apiKey, serviceId, id);
    if (deploy.status !== last) {
      last = deploy.status;
      console.log(`${new Date().toISOString()} deploy ${id}: ${deploy.status}`);
    }
    if (deploy.status === "live") {
      console.log(
        `Deploy live. created=${deploy.createdAt ?? "?"} started=${deploy.startedAt ?? "?"} finished=${deploy.finishedAt ?? "?"}`,
      );
      return;
    }
    if (DEPLOY_FAILED.has(deploy.status)) {
      console.error(`STOP: deploy ${id} ended in state ${deploy.status}.`);
      process.exit(3);
    }
    if (Date.now() > deadline) {
      console.error(`STOP: deploy ${id} still ${deploy.status} after ${timeoutMinutes} minutes.`);
      process.exit(4);
    }
    await sleep(15_000);
  }
}

async function setGroupVar(
  apiKey: string,
  groupName: string,
  key: string,
  value: string,
): Promise<void> {
  const owner = await render<Array<{ owner: { id: string } }>>(apiKey, "GET", "/owners?limit=100");
  let group: EnvGroup | undefined;
  for (const row of owner) {
    group = await findEnvGroup(apiKey, row.owner.id, groupName);
    if (group) break;
  }
  if (!group) {
    console.error(`STOP: environment group "${groupName}" not found.`);
    process.exit(2);
  }
  const updated = await render<EnvGroup>(
    apiKey,
    "PUT",
    `/env-groups/${group.id}/env-vars/${encodeURIComponent(key)}`,
    { value },
  );
  const present = (updated.envVars ?? []).some(
    (entry) => entry.key === key && entry.value === value,
  );
  console.log(`Group "${groupName}" (${group.id}): ${key} ${present ? "updated" : "NOT updated"}.`);
  if (!present) process.exit(3);
}

async function findGroupAnyOwner(
  apiKey: string,
  groupName: string,
): Promise<EnvGroup | undefined> {
  const owners = await render<Array<{ owner: { id: string } }>>(apiKey, "GET", "/owners?limit=100");
  for (const row of owners) {
    const group = await findEnvGroup(apiKey, row.owner.id, groupName);
    if (group) return group;
  }
  return undefined;
}

async function poolGroupDatabaseUrl(apiKey: string, groupName: string): Promise<void> {
  const group = await findGroupAnyOwner(apiKey, groupName);
  if (!group) {
    console.error(`STOP: environment group "${groupName}" not found.`);
    process.exit(2);
  }
  const full = await render<EnvGroup>(apiKey, "GET", `/env-groups/${group.id}`);
  const direct = (full.envVars ?? []).find((entry) => entry.key === "DATABASE_URL")?.value;
  if (direct === undefined) {
    console.error(`STOP: group "${groupName}" has no DATABASE_URL.`);
    process.exit(2);
  }
  let pooled: string;
  try {
    pooled = poolDatabaseUrl(direct);
  } catch (error) {
    console.error(`STOP: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  // Direct first, then pooled: if the second write fails, the group still
  // holds a consistent pair (direct == unpooled DATABASE_URL, as before).
  await render(apiKey, "PUT", `/env-groups/${group.id}/env-vars/DIRECT_DATABASE_URL`, { value: direct });
  await render(apiKey, "PUT", `/env-groups/${group.id}/env-vars/DATABASE_URL`, { value: pooled });
  const reread = await render<EnvGroup>(apiKey, "GET", `/env-groups/${group.id}`);
  const vars = reread.envVars ?? [];
  const directOk = vars.some((entry) => entry.key === "DIRECT_DATABASE_URL" && entry.value === direct);
  const pooledOk = vars.some((entry) => entry.key === "DATABASE_URL" && entry.value === pooled);
  console.log(`Group "${groupName}" (${group.id}):`);
  console.log(`  DIRECT_DATABASE_URL ${directOk ? "written (= previous DATABASE_URL)" : "NOT written"}`);
  console.log(`  DATABASE_URL        ${pooledOk ? "rewritten to the -pooler host with pgbouncer=true" : "NOT rewritten"}`);
  if (!directOk || !pooledOk) process.exit(3);
  console.log("Next: trigger-deploy, wait-deploy, then verify /healthz and one classic + one AI search.");
}

// --- main -----------------------------------------------------------------

const usage =
  "usage: render-migrate.mts preflight | inspect <serviceId> | create-group <serviceId> <groupName> | link-group <groupName> <serviceId> | create-service <oldServiceId> <name> <region> | deploys <serviceId> | trigger-deploy <serviceId> | wait-deploy <serviceId> [deployId] [timeoutMinutes] | set-group-var <groupName> <key> <value> | pool-database-url <groupName>";

async function main(argv: readonly string[]): Promise<void> {
const [command, ...rest] = argv;
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
    case "create-service": {
      const [oldServiceId, name, region] = rest;
      if (!oldServiceId || !name || !region) throw new Error(usage);
      await createService(requireApiKey(), oldServiceId, name, region);
      break;
    }
    case "deploys": {
      const [serviceId] = rest;
      if (!serviceId) throw new Error(usage);
      await listDeploys(requireApiKey(), serviceId);
      break;
    }
    case "trigger-deploy": {
      const [serviceId] = rest;
      if (!serviceId) throw new Error(usage);
      await triggerDeploy(requireApiKey(), serviceId);
      break;
    }
    case "wait-deploy": {
      const [serviceId, deployId, timeout] = rest;
      if (!serviceId) throw new Error(usage);
      await waitDeploy(requireApiKey(), serviceId, deployId, timeout ? Number(timeout) : 15);
      break;
    }
    case "set-group-var": {
      const [groupName, key, value] = rest;
      if (!groupName || !key || value === undefined) throw new Error(usage);
      await setGroupVar(requireApiKey(), groupName, key, value);
      break;
    }
    case "pool-database-url": {
      const [groupName] = rest;
      if (!groupName) throw new Error(usage);
      await poolGroupDatabaseUrl(requireApiKey(), groupName);
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
}

// Run only as a CLI: the unit test imports poolDatabaseUrl without
// executing a command (same guard as latency-probe.mts).
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main(process.argv.slice(2));
}
