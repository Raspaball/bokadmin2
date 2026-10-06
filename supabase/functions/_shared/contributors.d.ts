// Typer for contributors.js (Deno). Se contributors.js for regelen.
export declare const INSTITUTION_NAMES: string[];
export declare const INSTITUTION_PATTERNS: RegExp[];
export declare const ORGANISATION_SUFFIXES: string[];
export declare const ORGANISATION_WORDS: string[];
export declare function looksLikeOrganisation(name: string): boolean;
export declare function institutionByName(name: string): string | null;
export declare function isInstitutionName(name: string): boolean;
export declare function institutionReason(c: { name: string; corporate?: boolean }): string | null;
export declare function personAuthors(names: readonly string[] | null | undefined): string[];
export declare function institutionsCsv(institutions: Record<string, { reason: string; roles: string[]; count: number; isbns: string[] }>): string;
