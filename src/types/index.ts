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

export interface PackageDescription {
    systemRequirements: string;
    hasRextendrConfig: boolean;
}

export interface InstallTxtLogSource {
    packageName: string;
    flavor: string;
    url: string;
}

export interface PackageCacheEntry {
    version: string;
    needsCompilation: boolean;
    isRustDependent: boolean;
    systemRequirements: string;
    checkedAt: string;
}

export interface PackageCacheFile {
    updatedAt: string;
    packages: Record<string, PackageCacheEntry>;
}

export interface InstallLogCacheEntry {
    packageName: string;
    flavor: string;
    url: string;
    lastModified: string;
    rustc: string;
    observedAt: string;
}

export interface InstallLogCacheFile {
    updatedAt: string;
    logs: Record<string, InstallLogCacheEntry>;
}
