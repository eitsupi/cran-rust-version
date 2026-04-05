import { parse, SemVer } from "./deps.ts";
import { fetchWithRetry } from "./http.ts";
import {
    InstallTxtLogSource,
    PackageDescription,
    PackageIndexEntry,
    VersionInfo,
} from "./types/index.ts";

const PACKAGES_URL = "https://cran.r-project.org/src/contrib/PACKAGES.gz";
const CHECK_SUMMARY_BY_PACKAGE_URL =
    "https://cran.r-project.org/web/checks/check_summary_by_package.html";

function splitDcfRecords(dcfText: string): string[] {
    return dcfText.split(/\n\n+/).filter((record) => record.trim().length > 0);
}

function parseDcfRecord(record: string): Record<string, string> {
    const fields: Record<string, string> = {};
    let currentKey = "";
    for (const line of record.split("\n")) {
        const fieldMatch = line.match(/^([A-Za-z][A-Za-z0-9\/-]*):\s*(.*)$/);
        if (fieldMatch) {
            currentKey = fieldMatch[1];
            fields[currentKey] = fieldMatch[2];
            continue;
        }
        const continuationMatch = line.match(/^\s+(.*)$/);
        if (continuationMatch && currentKey) {
            fields[currentKey] = `${fields[currentKey]} ${continuationMatch[1]}`.trim();
        }
    }
    return fields;
}

async function gunzipToText(gzData: Uint8Array): Promise<string> {
    const gzCopy = new Uint8Array(gzData.byteLength);
    gzCopy.set(gzData);
    const stream = new Blob([gzCopy]).stream().pipeThrough(
        new DecompressionStream("gzip"),
    );
    return await new Response(stream).text();
}

function toBoolYesNo(value: string | undefined): boolean {
    return (value ?? "").trim().toLowerCase() === "yes";
}

function parsePackageNameFromCheckUrl(checkUrl: string): string {
    const match = checkUrl.match(/\/([^/]+)-00check\.html$/);
    return match?.[1] ?? "";
}

function parseFlavorFromCheckUrl(checkUrl: string): string {
    const match = checkUrl.match(/\/nosvn\/R\.check\/([^/]+)\//);
    return match?.[1] ?? "";
}

export async function fetchPackageIndex(): Promise<PackageIndexEntry[]> {
    const res = await fetchWithRetry(PACKAGES_URL);
    if (!res.ok) {
        throw new Error(`Failed to fetch ${PACKAGES_URL}: ${res.status} ${res.statusText}`);
    }
    const compressed = new Uint8Array(await res.arrayBuffer());
    const dcfText = await gunzipToText(compressed);
    const records = splitDcfRecords(dcfText);
    const entries: PackageIndexEntry[] = [];

    for (const record of records) {
        const fields = parseDcfRecord(record);
        const packageName = fields.Package;
        const version = fields.Version;
        if (!packageName || !version) {
            continue;
        }
        entries.push({
            packageName,
            version,
            needsCompilation: toBoolYesNo(fields.NeedsCompilation),
        });
    }

    return entries;
}

export async function fetchPackageDescription(
    packageName: string,
): Promise<PackageDescription | null> {
    const descriptionUrl =
        `https://cran.r-project.org/web/packages/${packageName}/DESCRIPTION`;
    const res = await fetchWithRetry(descriptionUrl);
    if (!res.ok) {
        console.error(
            `Error: ${descriptionUrl} returned ${res.status} ${res.statusText}`,
        );
        return null;
    }
    const body = await res.text();
    const records = splitDcfRecords(body);
    if (records.length === 0) {
        return null;
    }
    const fields = parseDcfRecord(records[0]);
    const hasRextendrConfig = Object.keys(fields).some((key) =>
        key.toLowerCase() === "config/rextendr/version"
    );
    return {
        systemRequirements: fields.SystemRequirements ?? "",
        hasRextendrConfig,
    };
}

export function isRustDependent(description: PackageDescription | null): boolean {
    if (!description) {
        return false;
    }
    if (description.hasRextendrConfig) {
        return true;
    }
    return /\brustc\b|\bcargo\b|\brust\b/i.test(
        description.systemRequirements,
    );
}

export async function fetchInstallTxtLinksForPackages(
    rustPackages: Set<string>,
): Promise<InstallTxtLogSource[]> {
    const res = await fetchWithRetry(CHECK_SUMMARY_BY_PACKAGE_URL);
    if (!res.ok) {
        throw new Error(
            `Failed to fetch ${CHECK_SUMMARY_BY_PACKAGE_URL}: ${res.status} ${res.statusText}`,
        );
    }
    const html = await res.text();
    const checkUrlPattern =
        /https:\/\/www\.[Rr]-project\.org\/nosvn\/R\.check\/[^"\s<>]+-00check\.html/g;
    const checkUrls = html.match(checkUrlPattern) ?? [];
    const links: InstallTxtLogSource[] = [];
    const seen = new Set<string>();

    for (const checkUrl of checkUrls) {
        const packageName = parsePackageNameFromCheckUrl(checkUrl);
        if (!packageName || !rustPackages.has(packageName)) {
            continue;
        }
        const flavor = parseFlavorFromCheckUrl(checkUrl);
        if (!flavor) {
            continue;
        }
        const installTxtUrl = checkUrl.replace("-00check.html", "-00install.txt");
        const key = `${packageName}::${flavor}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        links.push({ packageName, flavor, url: installTxtUrl });
    }

    return links;
}

export function extractSemver(ver: string): SemVer {
    const match = ver.match(/\d+\.\d+(\.\d+)?/) ?? ["0.0.0"];
    return parse(match[0]);
}

export async function fetchInstallTxtLastModified(
    logUrl: string,
): Promise<string> {
    const res = await fetchWithRetry(logUrl, { method: "HEAD" });
    if (!res.ok) {
        return "";
    }
    return res.headers.get("last-modified") ?? "";
}

export async function fetchVersionInfoFromInstallTxt(
    source: InstallTxtLogSource,
): Promise<VersionInfo | null> {
    console.log(`Extracting Rust version from ${source.url}`);
    let res;
    try {
        res = await fetchWithRetry(source.url);
    } catch (e) {
        console.error(`Error fetching ${source.url}:`, e);
        return null;
    }
    if (!res.ok) {
        console.error(
            `Error: ${source.url} returned ${res.status} ${res.statusText}`,
        );
        return null;
    }
    const body = await res.text();
    const lines = body.split("\n");
    const rustVersion = extractSemver(
        lines.find((line: string) => line.match("rustc [0-9]")) ?? "",
    );
    return { flavor: source.flavor, rustc: rustVersion };
}
