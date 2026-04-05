import {
    fetchInstallTxtLastModified,
    fetchInstallTxtLinksForPackages,
    fetchPackageIndex,
    fetchRUniversePackageInfo,
    fetchVersionInfoFromInstallTxt,
    isRustDependentFromMetadata,
} from "./scraper.ts";
import {
    InstallLogCacheFile,
    PackageIndexEntry,
    PackageCheckEntry,
    PackageCheckFile,
    VersionInfo,
} from "./types/index.ts";
import { latestVersions } from "./utils.ts";
import { compare, format, parse } from "./deps.ts";

const PACKAGE_CHECK_PATH = "./output/cache/package-check.json";
const INSTALL_LOG_CACHE_PATH = "./output/cache/install-logs.json";
const RUNIVERSE_FETCH_CONCURRENCY = 20;
const INSTALL_LOG_FETCH_CONCURRENCY = 20;
const NO_VALIDATOR_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function defaultPackageCheck(): PackageCheckFile {
    return {
        updatedAt: new Date().toISOString(),
        packages: {},
    };
}

function defaultInstallLogCache(): InstallLogCacheFile {
    return {
        updatedAt: new Date().toISOString(),
        logs: {},
    };
}

async function loadJsonOrDefault<T>(
    path: string,
    fallback: T,
): Promise<T> {
    try {
        const raw = await Deno.readTextFile(path);
        return JSON.parse(raw) as T;
    } catch (e) {
        if (e instanceof Deno.errors.NotFound) {
            return fallback;
        }
        if (e instanceof SyntaxError) {
            console.warn(`Invalid JSON at ${path}, falling back to defaults.`);
            return fallback;
        }
        throw e;
    }
}

function isCacheFreshWithoutValidator(observedAt: string): boolean {
    const observedTime = Date.parse(observedAt);
    if (Number.isNaN(observedTime)) {
        return false;
    }
    return Date.now() - observedTime <= NO_VALIDATOR_CACHE_TTL_MS;
}

function parseCachedRustc(rustc: string) {
    try {
        return parse(rustc);
    } catch {
        return null;
    }
}

function installLogCacheKey(packageName: string, flavor: string): string {
    return `${packageName}::${flavor}`;
}

async function main() {
    const packageCheck = await loadJsonOrDefault(
        PACKAGE_CHECK_PATH,
        defaultPackageCheck(),
    );
    const installLogCache = await loadJsonOrDefault(
        INSTALL_LOG_CACHE_PATH,
        defaultInstallLogCache(),
    );

    const packageIndex = await fetchPackageIndex();
    const compilationPackageNames = new Set(
        packageIndex
            .filter((entry) => entry.needsCompilation)
            .map((entry) => entry.packageName),
    );

    const candidatePackages = new Set<string>();
    const entriesToRefresh: PackageIndexEntry[] = [];
    for (const entry of packageIndex) {
        const previous = packageCheck.packages[entry.packageName];
        if (!entry.needsCompilation) {
            continue;
        }

        if (previous && previous.version === entry.version) {
            candidatePackages.add(entry.packageName);
            continue;
        }

        entriesToRefresh.push(entry);
    }

    for (
        let i = 0;
        i < entriesToRefresh.length;
        i += RUNIVERSE_FETCH_CONCURRENCY
    ) {
        const chunk = entriesToRefresh.slice(i, i + RUNIVERSE_FETCH_CONCURRENCY);
        const refreshed = await Promise.all(
            chunk.map(async (entry) => {
                const fetched = await fetchRUniversePackageInfo(entry.packageName);
                const rustDependent = isRustDependentFromMetadata(fetched.metadata);
                const cacheEntry: PackageCheckEntry = {
                    version: entry.version,
                    checkedAt: new Date().toISOString(),
                };
                return {
                    packageName: entry.packageName,
                    cacheEntry,
                    rustDependent,
                    status: fetched.status,
                };
            }),
        );

        for (const item of refreshed) {
            const previous = packageCheck.packages[item.packageName];
            if (item.status === "error" || item.status === "not_found") {
                // Keep the previous decision on transient API failures.
                if (previous) {
                    // Preserve the last evaluated version so newer versions are retried.
                    packageCheck.packages[item.packageName] = previous;
                    candidatePackages.add(item.packageName);
                }
                continue;
            }

            if (item.rustDependent) {
                packageCheck.packages[item.packageName] = item.cacheEntry;
                candidatePackages.add(item.packageName);
            } else {
                delete packageCheck.packages[item.packageName];
            }
        }
    }

    for (const packageName of Object.keys(packageCheck.packages)) {
        if (!compilationPackageNames.has(packageName)) {
            delete packageCheck.packages[packageName];
        }
    }

    const installLogs = await fetchInstallTxtLinksForPackages(candidatePackages);

    const versions: VersionInfo[] = [];
    const observedKeys = new Set<string>();
    for (
        let i = 0;
        i < installLogs.length;
        i += INSTALL_LOG_FETCH_CONCURRENCY
    ) {
        const chunk = installLogs.slice(i, i + INSTALL_LOG_FETCH_CONCURRENCY);
        const results = await Promise.all(
            chunk.map(async (log) => {
                const key = installLogCacheKey(log.packageName, log.flavor);
                const cached = installLogCache.logs[key];

                if (
                    cached &&
                    cached.url === log.url &&
                    cached.lastModified === "" &&
                    isCacheFreshWithoutValidator(cached.observedAt)
                ) {
                    const cachedRustc = parseCachedRustc(cached.rustc);
                    if (cachedRustc && format(cachedRustc) !== "0.0.0") {
                        return {
                            key,
                            version: {
                                flavor: cached.flavor,
                                rustc: cachedRustc,
                            } as VersionInfo,
                            cacheEntry: null,
                            dropCache: false,
                        };
                    }
                    return { key, version: null, cacheEntry: null, dropCache: false };
                }

                const validator = await fetchInstallTxtLastModified(log.url);

                if (
                    cached &&
                    cached.url === log.url &&
                    validator !== "" &&
                    cached.lastModified === validator
                ) {
                    const cachedRustc = parseCachedRustc(cached.rustc);
                    if (cachedRustc && format(cachedRustc) !== "0.0.0") {
                        return {
                            key,
                            version: {
                                flavor: cached.flavor,
                                rustc: cachedRustc,
                            } as VersionInfo,
                            cacheEntry: null,
                            dropCache: false,
                        };
                    }
                    // Re-fetch when cache content is unusable even if validator matches.
                }

                if (
                    cached &&
                    cached.url === log.url &&
                    validator === "" &&
                    isCacheFreshWithoutValidator(cached.observedAt)
                ) {
                    const cachedRustc = parseCachedRustc(cached.rustc);
                    if (cachedRustc && format(cachedRustc) !== "0.0.0") {
                        return {
                            key,
                            version: {
                                flavor: cached.flavor,
                                rustc: cachedRustc,
                            } as VersionInfo,
                            cacheEntry: null,
                            dropCache: false,
                        };
                    }
                    return { key, version: null, cacheEntry: null, dropCache: false };
                }

                const versionInfo = await fetchVersionInfoFromInstallTxt(log);
                if (versionInfo && format(versionInfo.rustc) !== "0.0.0") {
                    return {
                        key,
                        version: versionInfo,
                        cacheEntry: {
                            packageName: log.packageName,
                            flavor: log.flavor,
                            url: log.url,
                            lastModified: validator,
                            rustc: format(versionInfo.rustc),
                            observedAt: new Date().toISOString(),
                        },
                        dropCache: false,
                    };
                }

                if (cached && cached.url === log.url && validator === "") {
                    return {
                        key,
                        version: null,
                        cacheEntry: null,
                        dropCache: false,
                    };
                }

                return {
                    key,
                    version: null,
                    cacheEntry: null,
                    dropCache: true,
                };
            }),
        );

        for (const result of results) {
            observedKeys.add(result.key);
            if (result.version) {
                versions.push(result.version);
            }
            if (result.cacheEntry) {
                installLogCache.logs[result.key] = result.cacheEntry;
            } else if (result.dropCache) {
                delete installLogCache.logs[result.key];
            }
        }
    }

    for (const key of Object.keys(installLogCache.logs)) {
        if (!observedKeys.has(key)) {
            delete installLogCache.logs[key];
        }
    }

    const uniqueVersions = latestVersions(versions)
        .sort((a, b) => {
            if (compare(a.rustc, b.rustc) === 0) {
                return a.flavor.localeCompare(b.flavor);
            }
            return compare(a.rustc, b.rustc);
        });

    const versionsJson = JSON.stringify(
        uniqueVersions.map((version) => {
            return {
                flavor: version.flavor,
                rustc: format(version.rustc),
            };
        }),
        null,
        4,
    );
    const versionsJsonPath = "./output/versions.json";
    await Deno.mkdir("./output/cache", { recursive: true });
    await Deno.writeTextFile(versionsJsonPath, versionsJson);
    packageCheck.updatedAt = new Date().toISOString();
    installLogCache.updatedAt = new Date().toISOString();
    await Deno.writeTextFile(
        PACKAGE_CHECK_PATH,
        JSON.stringify(packageCheck, null, 2),
    );
    await Deno.writeTextFile(
        INSTALL_LOG_CACHE_PATH,
        JSON.stringify(installLogCache, null, 2),
    );
}

if (import.meta.main) {
    main();
}
