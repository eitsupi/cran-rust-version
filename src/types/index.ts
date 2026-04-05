import { SemVer } from "../deps.ts";

export interface VersionInfo {
    flavor: string;
    rustc: SemVer;
}

export interface PackageIndexEntry {
    packageName: string;
    version: string;
    needsCompilation: boolean;
}

export interface InstallTxtLogSource {
    packageName: string;
    flavor: string;
    url: string;
}

export interface RUniversePackageInfo {
    version: string;
    needsCompilation: boolean;
    systemRequirements: string;
    hasRextendrConfig: boolean;
}

export interface RUniversePackageFetchResult {
    status: "ok" | "not_found" | "error";
    metadata: RUniversePackageInfo | null;
}

export interface PackageCheckEntry {
    version: string;
    checkedAt: string;
}

export interface PackageCheckFile {
    updatedAt: string;
    packages: Record<string, PackageCheckEntry>;
}

export interface InstallLogCacheEntry {
    packageName: string;
    flavor: string;
    url: string;
    validator: string;
    rustc: string;
    observedAt: string;
}

export interface InstallLogCacheFile {
    updatedAt: string;
    logs: Record<string, InstallLogCacheEntry>;
}
