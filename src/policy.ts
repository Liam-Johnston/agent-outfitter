/**
 * Trust policy.
 *
 * Skills ship code that runs inside the agent's environment, so provenance is a
 * first-class concern rather than a lint. Everything enforced here happens at
 * resolve time — before a single byte is written into a target.
 */

import { PolicyViolationError } from "./errors.js";
import { describeMcpServer, mcpHost } from "./primitives/mcp.js";
import { describeSource, sourceHost, sourceOwner } from "./refs.js";
import type {
  McpServer,
  ResolvedPolicy,
  PrimitiveSource,
  OutfitterWarning,
  TrustPolicy,
} from "./types.js";

export const DEFAULT_POLICY: ResolvedPolicy = {
  requireLockHashMatch: true,
  scripts: "warn",
  scan: "warn",
  allowTransitiveMcp: false,
  allowTransitiveInstructions: false,
  allowLocalSources: true,
};

export const resolvePolicy = (...layers: (TrustPolicy | undefined)[]): ResolvedPolicy => {
  const out: ResolvedPolicy = { ...DEFAULT_POLICY };
  for (const layer of layers) {
    if (layer) Object.assign(out, stripUndefined(layer));
  }
  return out;
};

const stripUndefined = <T extends object>(value: T): Partial<T> =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;

/** `true` when `host` equals an allowed host or is a subdomain of one. */
const hostAllowed = (host: string, allowed: readonly string[]): boolean =>
  allowed.some((a) => {
    const norm = a.toLowerCase().replace(/^\./, "");
    return host === norm || host.endsWith(`.${norm}`);
  });

export const assertSourceAllowed = (source: PrimitiveSource, policy: ResolvedPolicy): void => {
  if (source.type === "local") {
    if (policy.allowLocalSources === false) {
      throw new PolicyViolationError(
        `Local source ${source.path} is blocked by policy.allowLocalSources=false.`,
        { source },
      );
    }
    return;
  }

  const host = sourceHost(source);
  if (policy.allowedHosts && policy.allowedHosts.length > 0) {
    if (!host || !hostAllowed(host, policy.allowedHosts)) {
      throw new PolicyViolationError(
        `Source ${describeSource(source)} resolves to host "${host ?? "unknown"}", ` +
          `which is not in policy.allowedHosts [${policy.allowedHosts.join(", ")}].`,
        { source, host },
      );
    }
  }

  const owner = sourceOwner(source);
  if (policy.allowedOwners && policy.allowedOwners.length > 0) {
    if (!owner || !policy.allowedOwners.some((o) => o.toLowerCase() === owner.toLowerCase())) {
      throw new PolicyViolationError(
        `Source ${describeSource(source)} has owner "${owner ?? "unknown"}", ` +
          `which is not in policy.allowedOwners [${policy.allowedOwners.join(", ")}].`,
        { source, owner },
      );
    }
  }
};

export interface McpTrustDecision {
  trusted: boolean;
  warning?: OutfitterWarning;
}

/**
 * Gate an MCP server.
 *
 * Manifest-declared servers are trusted by definition — the operator wrote them
 * down. Servers pulled in transitively by a skill are the interesting case:
 * they are dropped with a warning unless `allowTransitiveMcp` is set or the
 * server matches an explicit allowlist. This is the non-interactive analogue of
 * APM's MCP trust prompt.
 */
export const decideMcpTrust = (
  name: string,
  server: McpServer,
  declaredBy: string,
  policy: ResolvedPolicy,
): McpTrustDecision => {
  if (declaredBy === "manifest") return { trusted: true };

  const host = mcpHost(server);
  if (host && policy.allowedMcpHosts && hostAllowed(host, policy.allowedMcpHosts)) {
    return { trusted: true };
  }
  if (
    server.transport === "stdio" &&
    policy.allowedMcpCommands &&
    policy.allowedMcpCommands.includes(server.command)
  ) {
    return { trusted: true };
  }
  if (policy.allowTransitiveMcp) return { trusted: true };

  return {
    trusted: false,
    warning: {
      code: "transitive-mcp-dropped",
      subject: name,
      message:
        `MCP server "${name}" (${describeMcpServer(server)}) was pulled in by "${declaredBy}" ` +
        `but is not declared in the manifest. It was dropped. Declare it under "mcp:", ` +
        `set policy.allowTransitiveMcp=true, or allowlist it via policy.allowedMcpHosts / ` +
        `policy.allowedMcpCommands.`,
      detail: { declaredBy, host },
    },
  };
};

/**
 * Gate an instruction fragment.
 *
 * Same trust boundary as MCP, and for a sharper reason: an instruction fragment
 * is text spliced directly into the agent's standing context. A dependency that
 * could add one silently could rewrite the agent's operating rules without
 * appearing anywhere in the operator's manifest. So a fragment reached through a
 * skill is dropped unless the operator opts in.
 */
export const decideInstructionTrust = (
  name: string,
  declaredBy: string,
  policy: ResolvedPolicy,
): McpTrustDecision => {
  if (declaredBy === "manifest") return { trusted: true };
  if (policy.allowTransitiveInstructions) return { trusted: true };

  return {
    trusted: false,
    warning: {
      code: "transitive-instruction-dropped",
      subject: name,
      message:
        `Instruction fragment "${name}" was pulled in by "${declaredBy}" but is not declared ` +
        `in the manifest. It was dropped, because an instruction fragment edits the agent's ` +
        `standing context. Declare it under "instructions:" or set ` +
        `policy.allowTransitiveInstructions=true.`,
      detail: { declaredBy },
    },
  };
};
