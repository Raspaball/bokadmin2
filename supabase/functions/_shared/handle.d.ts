// Typer for handle.js (Deno). Se handle.js for regelen.
export declare const TITLE_MAX_LENGTH: number;
export declare function slugify(text: string): string;
export declare function truncateSlug(slug: string, max?: number): string;
export declare function mainTitle(title: string): string;
export declare function firstAuthor(authors: string[] | string | null | undefined): string;
export declare function isbn10to13(isbn10: string): string | null;
export declare function normalizeIsbn(value: string | null | undefined): string | null;
export declare function buildBookHandle(book: { title: string; authors?: string[] | string | null; isbn: string }): string | null;
