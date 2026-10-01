// Typer for onix.js (Deno). Se onix.js for regelen.
export declare const BOKGRUPPE_SCHEME: string;
export declare function stripNamespaces(xml: string): string;
export declare function extractBokgruppekode(xml: string): string | null;
export declare function extractAvailabilityCode(xml: string): string | null;
export declare function extractPublishingDate(xml: string): string | null;
