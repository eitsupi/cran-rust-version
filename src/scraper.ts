import { DOMParser, Element, parse, SemVer } from "./deps.ts";
import { VersionInfo } from "./types/index.ts";

export async function fetchCheckLinks(packageName: string): Promise<string[]> {
    const checkLinksUrl =
        `https://cran.r-project.org/web/checks/check_results_${packageName}.html`;
    const res = await fetch(checkLinksUrl);
    if (!res.ok) {
        throw new Error(`Failed to fetch ${checkLinksUrl}: ${res.status} ${res.statusText}`);
    }
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const container = doc?.querySelector(".container");
    const links = container?.querySelectorAll("a") ?? [];
    const hrefs = Array.from(links).map((link) =>
        (link as Element).getAttribute("href") ?? ""
    );
    const array = Array.from(
        new Set(
            hrefs.filter((href) => href.startsWith("https://")),
        ),
    );
    return [...new Set(array)];
}

export function convertToInstallLogs(checkLinks: string[]): string[] {
    return checkLinks.map((link) =>
        link.replace("00check.html", "00install.html")
    );
}

export function extractSemver(ver: string): SemVer {
    const match = ver.match(/\d+\.\d+(\.\d+)?/) ?? ["0.0.0"];
    return parse(match[0]);
}

export async function fetchVersionInfo(
    logUrl: string,
): Promise<VersionInfo | null> {
    console.log(`Extracting Rust version from ${logUrl}`);
    const flavor = logUrl.match(/(?<=\/)r-[^.\/]+/)?.[0] ?? logUrl.match(/(?<=\/pub\/bdr\/)[^\/]+(?=\/[^\/]+\.log$)/)?.[0] ?? "";
    let res;
    try {
        res = await fetch(logUrl);
    } catch (_e) {
        console.error(`Error: ${logUrl} is not found.`);
        return null;
    }
    if (!res.ok) {
        console.error(`Error: ${logUrl} returned ${res.status} ${res.statusText}`);
        return null;
    }
    const body = await res.text();
    const lines = body.split("\n");
    const rustVersion = extractSemver(
        lines.find((line: string) => line.match("rustc [0-9]")) ?? "",
    );
    return { flavor: flavor, rustc: rustVersion };
}
