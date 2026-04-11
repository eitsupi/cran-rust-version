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
const MAX_RUNIVERSE_REFRESH_PER_RUN = 800;
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

function toTimestampOrMin(iso: string): number {
    const time = Date.parse(iso);
    return Number.isNaN(time) ? Number.MIN_SAFE_INTEGER : time;
}

function packageRotationSalt(): number {
    // Daily deterministic rotation to avoid lexical bias when checkedAt ties.
    const daysSinceEpoch = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
    return daysSinceEpoch;
}

function hashPackageName(name: string): number {
    let hash = 2166136261;
    for (let i = 0; i < name.length; i += 1) {
        hash ^= name.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function packageRotationScore(name: string, salt: number): number {
    return (hashPackageName(name) + (salt >>> 0)) >>> 0;
}

function jsonSizeBytes(value: unknown): number {
    return new TextEncoder().encode(JSON.stringify(value)).length;
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

    const entriesToRefresh: Array<{
        entry: PackageIndexEntry;
        lastCheckedAt: string;
    }> = [];

    for (const entry of packageIndex) {
        if (!entry.needsCompilation) {
            continue;
        }

        const previous = packageCheck.packages[entry.packageName];
        if (!previous) {
            packageCheck.packages[entry.packageName] = {
                version: entry.version,
                checkedAt: "",
                rustDependency: "unknown",
            };
            entriesToRefresh.push({
                entry,
                lastCheckedAt: "",
            });
            continue;
        }

        if (previous.version !== entry.version) {
            previous.version = entry.version;
            previous.checkedAt = "";
            previous.rustDependency = "unknown";
        }

        if (
            previous.version === entry.version &&
            previous.rustDependency !== "unknown"
        ) {
            continue;
        }

        entriesToRefresh.push({
            entry,
            lastCheckedAt: previous.checkedAt,
        });
    }

    // Prefer least-recently checked packages so coverage progresses across runs.
    const rotationSalt = packageRotationSalt();
    entriesToRefresh.sort((a, b) => {
        const checkedAtDiff = toTimestampOrMin(a.lastCheckedAt) -
            toTimestampOrMin(b.lastCheckedAt);
        if (checkedAtDiff !== 0) {
            return checkedAtDiff;
        }
        const rotationDiff = packageRotationScore(a.entry.packageName, rotationSalt) -
            packageRotationScore(b.entry.packageName, rotationSalt);
        if (rotationDiff !== 0) {
            return rotationDiff;
        }
        return a.entry.packageName.localeCompare(b.entry.packageName);
    });
    const refreshTargets = entriesToRefresh
        .slice(0, MAX_RUNIVERSE_REFRESH_PER_RUN)
        .map((item) => item.entry);

    for (
        let i = 0;
        i < refreshTargets.length;
        i += RUNIVERSE_FETCH_CONCURRENCY
    ) {
        const chunk = refreshTargets.slice(i, i + RUNIVERSE_FETCH_CONCURRENCY);
        const refreshed = await Promise.all(
            chunk.map(async (entry) => {
                const fetched = await fetchRUniversePackageInfo(entry.packageName);
                const rustDependent = isRustDependentFromMetadata(fetched.metadata);
                const cacheEntry: PackageCheckEntry = {
                    version: entry.version,
                    checkedAt: new Date().toISOString(),
                    rustDependency: rustDependent ? "rust" : "not_rust",
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
                    // Preserve the last evaluated state so newer versions are retried.
                    packageCheck.packages[item.packageName] = previous;
                }
                continue;
            }

            packageCheck.packages[item.packageName] = item.cacheEntry;
        }
    }

    for (const packageName of Object.keys(packageCheck.packages)) {
        if (!compilationPackageNames.has(packageName)) {
            delete packageCheck.packages[packageName];
        }
    }

    const candidatePackages = new Set(
        Object.entries(packageCheck.packages)
            .filter(([, value]) => value.rustDependency === "rust")
            .map(([packageName]) => packageName),
    );

    const totalCompilationPackages = compilationPackageNames.size;
    const rustDependentPackages = candidatePackages.size;
    console.log(
        `Compilation packages: ${totalCompilationPackages}, rust-dependent: ${rustDependentPackages}, refresh targets this run: ${refreshTargets.length}`,
    );

    const installLogs = await fetchInstallTxtLinksForPackages(candidatePackages);
    console.log(`Install logs to inspect: ${installLogs.length}`);

    const versions: VersionInfo[] = [];
    const observedKeys = new Set<string>();
    const cacheStats = { fresh: 0, validated: 0, fetched: 0 };
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
                    cached.validator === "" &&
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
                            cacheStatus: "fresh" as const,
                        };
                    }
                    return { key, version: null, cacheEntry: null, dropCache: false, cacheStatus: "fresh" as const };
                }

                let validator = "";
                if (cached && cached.url === log.url) {
                    validator = await fetchInstallTxtLastModified(log.url);
                }

                if (
                    cached &&
                    cached.url === log.url &&
                    validator !== "" &&
                    cached.validator === validator
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
                            cacheStatus: "validated" as const,
                        };
                    }
                    // Re-fetch when cache content is unusable even if validator matches.
                }

                const fetchedInstallTxt = await fetchVersionInfoFromInstallTxt(log);
                const versionInfo = fetchedInstallTxt.versionInfo;
                const effectiveValidator = validator !== ""
                    ? validator
                    : fetchedInstallTxt.validator;
                const nextValidator = effectiveValidator !== ""
                    ? effectiveValidator
                    : (cached?.url === log.url ? cached.validator : "");
                if (versionInfo && format(versionInfo.rustc) !== "0.0.0") {
                    return {
                        key,
                        version: versionInfo,
                        cacheEntry: {
                            packageName: log.packageName,
                            flavor: log.flavor,
                            url: log.url,
                            validator: nextValidator,
                            rustc: format(versionInfo.rustc),
                            observedAt: new Date().toISOString(),
                        },
                        dropCache: false,
                        cacheStatus: "fetched" as const,
                    };
                }

                if (cached && cached.url === log.url) {
                    // Avoid reusing stale rustc after a detected validator update.
                    if (validator !== "" && cached.validator !== validator) {
                        return {
                            key,
                            version: null,
                            cacheEntry: {
                                packageName: log.packageName,
                                flavor: log.flavor,
                                url: log.url,
                                validator,
                                rustc: "0.0.0",
                                observedAt: new Date().toISOString(),
                            },
                            dropCache: false,
                            cacheStatus: "fetched" as const,
                        };
                    }

                    return {
                        key,
                        version: null,
                        cacheEntry: null,
                        dropCache: false,
                        cacheStatus: "fetched" as const,
                    };
                }

                return {
                    key,
                    version: null,
                    cacheEntry: null,
                    dropCache: true,
                    cacheStatus: "fetched" as const,
                };
            }),
        );

        for (const result of results) {
            observedKeys.add(result.key);
            cacheStats[result.cacheStatus]++;
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
    console.log(
        `Install log cache: ${cacheStats.fresh} fresh, ${cacheStats.validated} validated, ${cacheStats.fetched} fetched`,
    );

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
    await Deno.mkdir("./output", { recursive: true });
    await Deno.mkdir("./output/cache", { recursive: true });
    await Deno.writeTextFile(versionsJsonPath, versionsJson);
    packageCheck.updatedAt = new Date().toISOString();
    installLogCache.updatedAt = new Date().toISOString();
    console.log(
        `Cache entries: package-check=${Object.keys(packageCheck.packages).length}, install-logs=${Object.keys(installLogCache.logs).length}`,
    );
    console.log(
        `Cache size (bytes): package-check=${jsonSizeBytes(packageCheck)}, install-logs=${jsonSizeBytes(installLogCache)}`,
    );
    await Deno.writeTextFile(
        PACKAGE_CHECK_PATH,
        JSON.stringify(packageCheck),
    );
    await Deno.writeTextFile(
        INSTALL_LOG_CACHE_PATH,
        JSON.stringify(installLogCache),
    );
}

if (import.meta.main) {
    main();
}
