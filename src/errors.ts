/** Typed errors. Every failure skillsmith raises deliberately extends `SkillsmithError`. */

export type SkillsmithErrorCode =
  | "SOURCE_RESOLUTION"
  | "SKILL_NOT_FOUND"
  | "HASH_MISMATCH"
  | "POLICY_VIOLATION"
  | "CYCLE"
  | "TARGET"
  | "AUTH"
  | "MANIFEST"
  | "LOCKFILE"
  | "NOT_IMPLEMENTED";

export class SkillsmithError extends Error {
  readonly code: SkillsmithErrorCode;
  readonly detail: Record<string, unknown>;

  constructor(code: SkillsmithErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.detail = detail;
  }
}

export class SourceResolutionError extends SkillsmithError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super("SOURCE_RESOLUTION", message, detail);
  }
}

export class SkillNotFoundError extends SkillsmithError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super("SKILL_NOT_FOUND", message, detail);
  }
}

export class HashMismatchError extends SkillsmithError {
  readonly expected: string;
  readonly actual: string;

  constructor(name: string, expected: string, actual: string, detail?: Record<string, unknown>) {
    super(
      "HASH_MISMATCH",
      `Content hash mismatch for "${name}": lockfile has ${expected}, resolved tree is ${actual}. ` +
        `Re-run install to update the lockfile, or set policy.requireLockHashMatch=false to allow drift.`,
      { name, expected, actual, ...detail },
    );
    this.expected = expected;
    this.actual = actual;
  }
}

export class PolicyViolationError extends SkillsmithError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super("POLICY_VIOLATION", message, detail);
  }
}

export class CycleError extends SkillsmithError {
  readonly cycle: string[];

  constructor(cycle: string[]) {
    super("CYCLE", `Dependency cycle detected: ${cycle.join(" -> ")}`, { cycle });
    this.cycle = cycle;
  }
}

export class TargetError extends SkillsmithError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super("TARGET", message, detail);
  }
}

export class AuthError extends SkillsmithError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super("AUTH", message, detail);
  }
}

export class ManifestError extends SkillsmithError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super("MANIFEST", message, detail);
  }
}

export class LockfileError extends SkillsmithError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super("LOCKFILE", message, detail);
  }
}

export class NotImplementedError extends SkillsmithError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super("NOT_IMPLEMENTED", message, detail);
  }
}
