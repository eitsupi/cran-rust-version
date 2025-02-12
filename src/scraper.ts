import { axios, DOMParser, Element, parse, SemVer } from "./deps.ts";
import { VersionInfo } from "./types/index.ts";

export async function fetchCheckLinks(packageName: string): Promise<string[]> {
    const checkLinksUrl =
        `https://cran.r-project.org/web/checks/check_results_${packageName}.html`;
    const response = await axios.get(checkLinksUrl);
    const html = response.data;
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
    const match = ver.match(/\d+\.\d+(\.\d+)?/) ?? [""];
    return parse(match[0]);
}

export async function fetchVersionInfo(
    logUrl: string,
): Promise<VersionInfo | null> {
    console.log(`Extracting Rust version from ${logUrl}`);
    const flavor = logUrl.match(/(?<=\/)r-[^.\/]+/)?.[0] ?? "";
    let response;
    try {
        response = await axios.get(logUrl);
    } catch (_e) {
        console.error(`Error: ${logUrl} is not found.`);
        return null;
    }
    const lines = response.data.split("\n");
    const rustVersion = extractSemver(
        lines.find((line: string) => line.match("rustc [0-9]")) ?? "",
    );
    return { flavor: flavor, rustc: rustVersion };
}
