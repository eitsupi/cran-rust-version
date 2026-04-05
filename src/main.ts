import {
    fetchInstallTxtLastModified,
    fetchInstallTxtLinksForPackages,
    fetchPackageDescription,
    fetchPackageIndex,
    fetchVersionInfoFromInstallTxt,
    isRustDependent,
} from "./scraper.ts";
import {
    InstallLogCacheFile,
    PackageCacheEntry,
    PackageCacheFile,
    VersionInfo,
} from "./types/index.ts";
import { latestVersions } from "./utils.ts";
import { compare, format, parse } from "./deps.ts";

const PACKAGE_CACHE_PATH = "./output/cache/packages.json";
const INSTALL_LOG_CACHE_PATH = "./output/cache/install-logs.json";
const DESCRIPTION_FETCH_CONCURRENCY = 20;

function defaultPackageCache(): PackageCacheFile {
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
        throw e;
    }
}

function installLogCacheKey(packageName: string, flavor: string): string {
    return `${packageName}::${flavor}`;
}

async function main() {
    const packageCache = await loadJsonOrDefault(
        PACKAGE_CACHE_PATH,
        defaultPackageCache(),
    );
    const installLogCache = await loadJsonOrDefault(
        INSTALL_LOG_CACHE_PATH,
        defaultInstallLogCache(),
    );

    const packageIndex = await fetchPackageIndex();
    const packageIndexMap = new Map(
        packageIndex.map((entry) => [entry.packageName, entry]),
    );

    const rustPackages = new Set<string>();
    const entriesToRefresh = [] as typeof packageIndex;
    for (const entry of packageIndex) {
        const cached = packageCache.packages[entry.packageName];
        if (
            cached &&
            cached.version === entry.version &&
            cached.needsCompilation === entry.needsCompilation
        ) {
            if (cached.isRustDependent) {
                rustPackages.add(entry.packageName);
            }
            continue;
        }

        if (!entry.needsCompilation) {
            const nextCacheEntry: PackageCacheEntry = {
                version: entry.version,
                needsCompilation: false,
                isRustDependent: false,
                systemRequirements: "",
                checkedAt: new Date().toISOString(),
            };
            packageCache.packages[entry.packageName] = nextCacheEntry;
            continue;
        }

        entriesToRefresh.push(entry);
    }

    for (
        let i = 0;
        i < entriesToRefresh.length;
        i += DESCRIPTION_FETCH_CONCURRENCY
    ) {
        const chunk = entriesToRefresh.slice(i, i + DESCRIPTION_FETCH_CONCURRENCY);
        const refreshed = await Promise.all(
            chunk.map(async (entry) => {
                const description = await fetchPackageDescription(entry.packageName);
                const rustDependent = isRustDependent(description);
                const nextCacheEntry: PackageCacheEntry = {
                    version: entry.version,
                    needsCompilation: true,
                    isRustDependent: rustDependent,
                    systemRequirements: description?.systemRequirements ?? "",
                    checkedAt: new Date().toISOString(),
                };
                return { entry, nextCacheEntry, rustDependent };
            }),
        );
        for (const item of refreshed) {
            packageCache.packages[item.entry.packageName] = item.nextCacheEntry;
            if (item.rustDependent) {
                rustPackages.add(item.entry.packageName);
            }
        }
    }

    for (const packageName of Object.keys(packageCache.packages)) {
        if (!packageIndexMap.has(packageName)) {
            delete packageCache.packages[packageName];
        }
    }

    const installLogs = await fetchInstallTxtLinksForPackages(rustPackages);

    const versions: VersionInfo[] = [];
    const observedKeys = new Set<string>();
    for (const log of installLogs) {
        const key = installLogCacheKey(log.packageName, log.flavor);
        observedKeys.add(key);
        const cached = installLogCache.logs[key];
        const lastModified = await fetchInstallTxtLastModified(log.url);

        if (
            cached &&
            cached.url === log.url &&
            lastModified !== "" &&
            cached.lastModified === lastModified
        ) {
            const cachedRustc = parse(cached.rustc);
            if (format(cachedRustc) !== "0.0.0") {
                versions.push({
                    flavor: cached.flavor,
                    rustc: cachedRustc,
                });
            }
            continue;
        }

        const versionInfo = await fetchVersionInfoFromInstallTxt(log);
        // 0.0.0 means the version is not found
        if (versionInfo && format(versionInfo.rustc) !== "0.0.0") {
            versions.push(versionInfo);
            installLogCache.logs[key] = {
                packageName: log.packageName,
                flavor: log.flavor,
                url: log.url,
                lastModified,
                rustc: format(versionInfo.rustc),
                observedAt: new Date().toISOString(),
            };
        }
    }

    for (const key of Object.keys(installLogCache.logs)) {
        if (!observedKeys.has(key)) {
            delete installLogCache.logs[key];
        }
    }

    const uniqueVersions = latestVersions(versions)
        .sort((a, b) => {
            if (a.rustc === b.rustc) {
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
    packageCache.updatedAt = new Date().toISOString();
    installLogCache.updatedAt = new Date().toISOString();
    await Deno.writeTextFile(
        PACKAGE_CACHE_PATH,
        JSON.stringify(packageCache, null, 2),
    );
    await Deno.writeTextFile(
        INSTALL_LOG_CACHE_PATH,
        JSON.stringify(installLogCache, null, 2),
    );
}

if (import.meta.main) {
    main();
}
