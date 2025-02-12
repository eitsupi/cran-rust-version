import { greaterThan } from "./deps.ts";
import { VersionInfo } from "./types/index.ts";

export function latestVersions(versions: VersionInfo[]): VersionInfo[] {
  const latests: VersionInfo[] = [];
  const seen = new Map<string, VersionInfo>();

  for (const version of versions) {
    const key = `${version.flavor}`;
    if (!seen.has(key)) {
      seen.set(key, version);
    } else {
      const seenVersion = seen.get(key)!;
      if (greaterThan(version.rustc, seenVersion.rustc)) {
        seen.set(key, version);
      }
    }
  }

  for (const version of seen.values()) {
    latests.push(version);
  }

  return latests;
}
