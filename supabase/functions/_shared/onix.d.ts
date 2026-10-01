// Typer for onix.js (Deno). Se onix.js for regelen.
export declare const BOKGRUPPE_SCHEME: string;
export declare function stripNamespaces(xml: string): string;
export declare function extractBokgruppekode(xml: string): string | null;
export declare function decodeXmlText(text: string): string;
export declare function uninvertName(inverted: string): string;
export declare function extractContributors(xml: string): { authors: string[]; role: string | null };
export declare function extractAvailabilityCode(xml: string): string | null;
export declare function extractProductForm(xml: string): { form: string | null; details: string[] };
export declare function extractPages(xml: string): number | null;
export declare function extractPublicationYear(xml: string): number | null;
export declare const LANGUAGE_NAMES: Record<string, string>;
export declare function extractLanguage(xml: string): string | null;
export declare function extractSeries(xml: string): string | null;
export declare function extractAudienceAge(xml: string): string | null;
export declare function extractThema(xml: string): string[];
export declare function extractPublishingDate(xml: string): string | null;
