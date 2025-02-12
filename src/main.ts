import {
    convertToInstallLogs,
    fetchCheckLinks,
    fetchVersionInfo,
} from "./scraper.ts";
import { VersionInfo } from "./types/index.ts";
import { latestVersions } from "./utils.ts";
import cran from "./data/cran.json" with { type: "json" };
import { compare, format } from "./deps.ts";

async function main() {
    const checkLinks = await Promise.all(
        cran.packages.map((name) => fetchCheckLinks(name)),
    ).then((res) => res.flat());
    const installLogs = convertToInstallLogs(checkLinks);

    const versions: VersionInfo[] = [];
    for (const log of installLogs) {
        const versionInfo = await fetchVersionInfo(log);
        if (versionInfo) {
            versions.push(versionInfo);
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
    await Deno.writeTextFile(versionsJsonPath, versionsJson);
}

if (import.meta.main) {
    main();
}
