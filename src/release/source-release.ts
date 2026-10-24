export interface SourceReleasePlan {
  readonly tag: string;
  readonly archive: string;
  readonly command: string;
}

/** Plan-only release support: the delivery controller performs publication. */
export function sourceReleasePlan(version: string): SourceReleasePlan {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error("version must be semver-like");
  const tag = `v${version}`;
  const prefix = `orchestration-tracking-${version}`;
  return {
    tag,
    archive: `${prefix}.tar.gz`,
    command: `git archive --format=tar.gz --prefix=${prefix}/ ${tag} > ${prefix}.tar.gz`,
  };
}
