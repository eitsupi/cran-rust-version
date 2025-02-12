import { SemVer } from "../deps.ts";

export interface VersionInfo {
    flavor: string;
    rustc: SemVer;
}
