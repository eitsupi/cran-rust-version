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
    PackageCheckEntry,
    PackageCheckFile,
    VersionInfo,
} from "./types/index.ts";
import { latestVersions } from "./utils.ts";
import { compare, format, parse } from "./deps.ts";

const PACKAGE_CHECK_PATH = "./output/cache/package-check.json";
const INSTALL_LOG_CACHE_PATH = "./output/cache/install-logs.json";
const RUNIVERSE_FETCH_CONCURRENCY = 20;

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
        throw e;
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
    const entriesToRefresh = [] as typeof packageIndex;
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
                const metadata = await fetchRUniversePackageInfo(entry.packageName);
                const rustDependent = isRustDependentFromMetadata(metadata);
                const cacheEntry: PackageCheckEntry = {
                    version: entry.version,
                    checkedAt: new Date().toISOString(),
                };
                return { packageName: entry.packageName, cacheEntry, rustDependent };
            }),
        );

        for (const item of refreshed) {
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
