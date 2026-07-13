// Railway GraphQL client + assembly of "tailnet services": for each Railway
// environment that runs a tailscale-rw subnet router, every other service in
// that environment is reachable from the tailnet at
// <private-domain-label>.<alias-suffix>, where the alias suffix is the one the
// router actually serves (default <project>-<env>-railway.internal, overridable
// via its TS_DNS_ALIAS_SUFFIX variable).

const ENDPOINT = "https://backboard.railway.com/graphql/v2";

// --- GraphQL plumbing ---------------------------------------------------------

interface GqlError {
  message: string;
}

async function gql<T>(
  token: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Cloudflare in front of the API rejects requests without a UA (error 1010)
      "user-agent": "raycast-railway-tailscale",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Railway rejected the API token (HTTP ${res.status}). Check the extension preferences.`,
      );
    }
    throw new Error(`Railway API HTTP ${res.status}: ${body}`);
  }
  const json = (await res.json()) as { data?: T; errors?: GqlError[] };
  if (json.errors?.length)
    throw new Error(`Railway API: ${json.errors[0].message}`);
  if (!json.data) throw new Error("Railway API returned no data");
  return json.data;
}

// --- Raw project listing ------------------------------------------------------

interface RawInstance {
  environmentId: string;
  source: { repo: string | null; image: string | null } | null;
}
interface RawService {
  id: string;
  name: string;
  serviceInstances: { edges: { node: RawInstance }[] };
}
interface RawProject {
  id: string;
  name: string;
  environments: { edges: { node: { id: string; name: string } }[] };
  services: { edges: { node: RawService }[] };
}

const PROJECT_FIELDS = `
  id name
  environments { edges { node { id name } } }
  services { edges { node {
    id name
    serviceInstances { edges { node {
      environmentId
      source { repo image }
    } } }
  } } }
`;

// Account tokens see projects under me.{projects,workspaces}; team tokens see
// them under the root projects query and cannot access me. Try both, merge.
async function listProjects(token: string): Promise<RawProject[]> {
  const byId = new Map<string, RawProject>();
  const errors: Error[] = [];

  await Promise.all([
    gql<{
      me: {
        projects: { edges: { node: RawProject }[] };
        workspaces: {
          team: { projects: { edges: { node: RawProject }[] } } | null;
        }[];
      };
    }>(
      token,
      `query { me {
        projects(first: 100) { edges { node { ${PROJECT_FIELDS} } } }
        workspaces { team { projects(first: 100) { edges { node { ${PROJECT_FIELDS} } } } } }
      } }`,
    ).then(
      (d) => {
        for (const e of d.me.projects.edges) byId.set(e.node.id, e.node);
        for (const ws of d.me.workspaces) {
          for (const e of ws.team?.projects.edges ?? [])
            byId.set(e.node.id, e.node);
        }
      },
      (e) => errors.push(e),
    ),
    gql<{ projects: { edges: { node: RawProject }[] } }>(
      token,
      `query { projects(first: 100) { edges { node { ${PROJECT_FIELDS} } } } }`,
    ).then(
      (d) => {
        for (const e of d.projects.edges) byId.set(e.node.id, e.node);
      },
      (e) => errors.push(e),
    ),
  ]);

  // Both shapes failing means the token itself is bad — surface that.
  if (byId.size === 0 && errors.length === 2) throw errors[0];
  return [...byId.values()];
}

type Variables = Record<string, string>;

function fetchVariables(
  token: string,
  projectId: string,
  environmentId: string,
  serviceId: string,
): Promise<Variables> {
  return gql<{ variables: Variables }>(
    token,
    `query($p: String!, $e: String!, $s: String!) {
      variables(projectId: $p, environmentId: $e, serviceId: $s)
    }`,
    { p: projectId, e: environmentId, s: serviceId },
  ).then((d) => d.variables ?? {});
}

// Bound concurrency so a big account doesn't burst-hit the API rate limit.
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

// --- Naming & port inference ----------------------------------------------------

// Mirrors sanitize() in start.sh: DNS-safe label — lowercase, alnum + hyphen.
export function sanitize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function defaultAliasSuffix(
  projectName: string,
  envName: string,
): string {
  return `${sanitize(projectName)}-${sanitize(envName)}-railway.internal`;
}

// The suffix the router actually serves: its TS_DNS_ALIAS_SUFFIX if set
// (none/off/false = plain railway.internal mode), else the start.sh default.
function aliasSuffix(
  routerVars: Variables | undefined,
  projectName: string,
  envName: string,
): string {
  const configured = routerVars?.TS_DNS_ALIAS_SUFFIX?.trim();
  if (configured) {
    return ["none", "off", "false"].includes(configured.toLowerCase())
      ? "railway.internal"
      : configured;
  }
  return defaultAliasSuffix(projectName, envName);
}

// Port variables in rough order of trustworthiness, then image defaults.
const PORT_VARS = [
  "RAILWAY_TCP_APPLICATION_PORT",
  "PORT",
  "PGPORT",
  "MYSQL_PORT",
  "REDIS_PORT",
  "MONGO_PORT",
];
const IMAGE_PORTS: [RegExp, number][] = [
  [/postgres|pgvector|timescale/i, 5432],
  [/mysql|mariadb/i, 3306],
  [/redis|valkey|keydb|dragonfly/i, 6379],
  [/mongo/i, 27017],
  [/clickhouse/i, 8123],
  [/rabbitmq/i, 5672],
  [/kafka/i, 9092],
  [/meilisearch/i, 7700],
  [/minio/i, 9000],
  [/n8n/i, 5678],
  [/gel|edgedb/i, 5656],
];

function inferPort(vars: Variables, image: string | null): number | undefined {
  for (const key of PORT_VARS) {
    const parsed = Number(vars[key]);
    if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) return parsed;
  }
  if (image) {
    for (const [re, port] of IMAGE_PORTS) if (re.test(image)) return port;
  }
  return undefined;
}

const DATABASE_IMAGE =
  /postgres|pgvector|timescale|mysql|mariadb|redis|valkey|keydb|dragonfly|mongo|clickhouse|gel|edgedb/i;

// First URL-shaped variable that points at this service's own private domain;
// rewriting its host to the tailnet alias yields a paste-ready connection string.
function findConnectionUrl(
  vars: Variables,
  privateDomain: string,
  tailnetHost: string,
): string | undefined {
  const candidates = [
    "DATABASE_URL",
    "DATABASE_PRIVATE_URL",
    ...Object.keys(vars).sort(),
  ];
  for (const key of candidates) {
    const value = vars[key];
    if (value && value.includes("://") && value.includes(privateDomain)) {
      return value.replaceAll(privateDomain, tailnetHost);
    }
  }
  return undefined;
}

// --- Assembly -------------------------------------------------------------------

export interface TailnetService {
  key: string;
  name: string;
  host: string;
  port?: number;
  connectionUrl?: string;
  /** Railway-provided public domain (service is also exposed publicly). */
  publicUrl?: string;
  isDatabase: boolean;
  image: string | null;
  repo: string | null;
}

export interface EnvGroup {
  key: string;
  projectId: string;
  environmentId: string;
  projectName: string;
  envName: string;
  suffix: string;
  routerName?: string;
  services: TailnetService[];
}

const ROUTER_HINT = /tailscale/i;

function looksLikeRouter(svc: RawService, inst: RawInstance): boolean {
  return (
    ROUTER_HINT.test(svc.name) ||
    ROUTER_HINT.test(inst.source?.repo ?? "") ||
    ROUTER_HINT.test(inst.source?.image ?? "")
  );
}

export async function loadEnvGroups(
  token: string,
  includeUnrouted: boolean,
): Promise<EnvGroup[]> {
  const projects = await listProjects(token);

  // (project, environment) pairs and the services instantiated in each
  const envs: {
    project: RawProject;
    envId: string;
    envName: string;
    services: { svc: RawService; inst: RawInstance }[];
    routerCandidate?: RawService;
  }[] = [];

  for (const project of projects) {
    for (const { node: env } of project.environments.edges) {
      const services: { svc: RawService; inst: RawInstance }[] = [];
      let routerCandidate: RawService | undefined;
      for (const { node: svc } of project.services.edges) {
        const inst = svc.serviceInstances.edges.find(
          (e) => e.node.environmentId === env.id,
        )?.node;
        if (!inst) continue;
        services.push({ svc, inst });
        if (!routerCandidate && looksLikeRouter(svc, inst))
          routerCandidate = svc;
      }
      if (services.length > 0 && (routerCandidate || includeUnrouted)) {
        envs.push({
          project,
          envId: env.id,
          envName: env.name,
          services,
          routerCandidate,
        });
      }
    }
  }

  // One variables query per service instance in the environments we kept.
  const jobs = envs.flatMap((env) =>
    env.services.map((entry) => ({ env, entry })),
  );
  const allVars = await mapPool(jobs, 5, ({ env, entry }) =>
    fetchVariables(token, env.project.id, env.envId, entry.svc.id).catch(
      () => ({}) as Variables,
    ),
  );
  const varsByKey = new Map(
    jobs.map((job, i) => [`${job.env.envId}/${job.entry.svc.id}`, allVars[i]]),
  );

  const groups: EnvGroup[] = [];
  for (const env of envs) {
    const varsOf = (svc: RawService) =>
      varsByKey.get(`${env.envId}/${svc.id}`) ?? {};

    // A router must look like one (tailscale in name/repo/image); among the
    // lookalikes, prefer the one actually carrying an auth key. The key alone
    // is NOT a marker — app services can carry a stray TAILSCALE_AUTHKEY.
    const router =
      env.services.find(
        ({ svc, inst }) =>
          looksLikeRouter(svc, inst) && "TAILSCALE_AUTHKEY" in varsOf(svc),
      )?.svc ?? env.routerCandidate;
    if (!router && !includeUnrouted) continue;

    const suffix = aliasSuffix(
      router && varsOf(router),
      env.project.name,
      env.envName,
    );
    const services: TailnetService[] = [];
    for (const { svc, inst } of env.services) {
      // Skip every router node, not just the chosen one — an environment can
      // carry more than one (e.g. an old forwarder next to tailscale-rw), and
      // none of them has a user-facing URL.
      if (svc.id === router?.id || looksLikeRouter(svc, inst)) continue;
      const vars = varsOf(svc);
      // Private DNS names are fixed at service creation and do not follow
      // renames, so RAILWAY_PRIVATE_DOMAIN is the source of truth — fall back
      // to the sanitized display name only when variables were unreadable.
      const privateDomain =
        vars.RAILWAY_PRIVATE_DOMAIN ?? `${sanitize(svc.name)}.railway.internal`;
      const label = privateDomain.replace(/\.railway\.internal$/, "");
      const host = `${label}.${suffix}`;
      const image = inst.source?.image ?? null;
      services.push({
        key: `${env.envId}/${svc.id}`,
        name: svc.name,
        host,
        port: inferPort(vars, image),
        connectionUrl: findConnectionUrl(vars, privateDomain, host),
        publicUrl: vars.RAILWAY_PUBLIC_DOMAIN
          ? `https://${vars.RAILWAY_PUBLIC_DOMAIN}`
          : undefined,
        isDatabase: DATABASE_IMAGE.test(image ?? ""),
        image,
        repo: inst.source?.repo ?? null,
      });
    }
    if (services.length === 0) continue; // router-only environment — nothing to browse
    services.sort((a, b) => a.name.localeCompare(b.name));
    groups.push({
      key: `${env.project.id}/${env.envId}`,
      projectId: env.project.id,
      environmentId: env.envId,
      projectName: env.project.name,
      envName: env.envName,
      suffix,
      routerName: router?.name,
      services,
    });
  }

  // Routed environments first, then alphabetical; production before other envs.
  groups.sort(
    (a, b) =>
      Number(!!b.routerName) - Number(!!a.routerName) ||
      a.projectName.localeCompare(b.projectName) ||
      Number(b.envName === "production") - Number(a.envName === "production") ||
      a.envName.localeCompare(b.envName),
  );
  return groups;
}
