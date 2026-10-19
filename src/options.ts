import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const SCHEMA_VERSION = 1 as const;

export interface PhaseMapping {
  readonly phaseKey: string;
  readonly phaseLabel: string;
  readonly repeatEligible: boolean;
}

export type PhaseMappings = Readonly<Record<string, PhaseMapping>>;

export interface TrackerOptions {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly dataDir: string;
  readonly phaseMappings: PhaseMappings;
}

export const DEFAULT_PHASE_MAPPINGS: Readonly<Record<string, PhaseMapping>> = {
  orchestrator: {
    phaseKey: "coordination-scoping",
    phaseLabel: "Coordination & Scoping",
    repeatEligible: false,
  },
  plan: {
    phaseKey: "planning",
    phaseLabel: "Planning",
    repeatEligible: true,
  },
  architect: {
    phaseKey: "architecture-decomposition",
    phaseLabel: "Architecture and Decomposition",
    repeatEligible: true,
  },
  planner: {
    phaseKey: "architecture-decomposition",
    phaseLabel: "Architecture and Decomposition",
    repeatEligible: true,
  },
  investigator: {
    phaseKey: "investigation",
    phaseLabel: "Investigation",
    repeatEligible: true,
  },
  worker: {
    phaseKey: "implementation",
    phaseLabel: "Implementation",
    repeatEligible: true,
  },
  reviewer: {
    phaseKey: "review",
    phaseLabel: "Review",
    repeatEligible: true,
  },
  integration: {
    phaseKey: "integration",
    phaseLabel: "Integration validation",
    repeatEligible: true,
  },
  build: {
    phaseKey: "build-direct",
    phaseLabel: "Build (Direct)",
    repeatEligible: true,
  },
};

export const UNMAPPED_PHASE: PhaseMapping = {
  phaseKey: "unmapped",
  phaseLabel: "Unmapped",
  repeatEligible: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validMapping(value: unknown): value is PhaseMapping {
  return (
    isRecord(value) &&
    typeof value.phaseKey === "string" &&
    value.phaseKey.length > 0 &&
    typeof value.phaseLabel === "string" &&
    value.phaseLabel.length > 0 &&
    typeof value.repeatEligible === "boolean"
  );
}

/** Parse the deliberately small public options contract at the plugin boundary. */
export function parseOptions(input: unknown = {}): TrackerOptions {
  if (!isRecord(input)) throw new Error("tracker options must be an object");
  if (input.schemaVersion !== undefined && input.schemaVersion !== SCHEMA_VERSION) {
    throw new Error("unsupported tracker options schema version");
  }

  const dataDir =
    input.dataDir === undefined
      ? join(homedir(), ".local", "share", "opencode", "orchestration-tracker")
      : input.dataDir;
  if (typeof dataDir !== "string" || !isAbsolute(dataDir)) {
    throw new Error("tracker dataDir must be an absolute path");
  }

  const phaseMappings: Record<string, PhaseMapping> = structuredClone(DEFAULT_PHASE_MAPPINGS);
  if (input.phaseMappings !== undefined) {
    if (!isRecord(input.phaseMappings)) throw new Error("phaseMappings must be an object");
    for (const [agent, mapping] of Object.entries(input.phaseMappings)) {
      if (!agent || !validMapping(mapping)) throw new Error("invalid phase mapping");
      if (agent === "__proto__" || agent === "constructor" || agent === "prototype") {
        throw new Error("invalid phase mapping agent");
      }
      if (agent === "orchestrator" && mapping.repeatEligible) {
        throw new Error("orchestrator repeat eligibility cannot be enabled");
      }
      phaseMappings[agent] = {
        phaseKey: mapping.phaseKey,
        phaseLabel: mapping.phaseLabel,
        repeatEligible: mapping.repeatEligible,
      };
    }
  }
  return { schemaVersion: SCHEMA_VERSION, dataDir, phaseMappings };
}

export function mappingFor(options: TrackerOptions, agent: string | undefined): PhaseMapping {
  return agent === undefined ? UNMAPPED_PHASE : (options.phaseMappings[agent] ?? UNMAPPED_PHASE);
}
