import { DeckSettings, DeckMeta, SlideData, SlidesFile } from './types';

// ─── Default values ───────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: DeckSettings = {
    theme: 'executive',
    aspectRatio: '16:9',
    transition: 'slide',
};

const DEFAULT_META: DeckMeta = {};

// ─── Parse ────────────────────────────────────────────────────────────────────

/**
 * Parse a .slides.html file into structured data.
 * Extracts:
 *   - orz-settings block  → DeckSettings
 *   - orz-meta block      → DeckMeta
 *   - Each orz-slide/section pair → SlideData[]
 */
export function parseSlidesFile(fileContent: string): SlidesFile {
    const settings = parseJsonBlock(fileContent, 'text/orz-settings', DEFAULT_SETTINGS) as DeckSettings;
    const meta     = parseJsonBlock(fileContent, 'text/orz-meta',     DEFAULT_META)     as DeckMeta;
    const slides   = parseSlides(fileContent);

    return { settings, meta, slides };
}

function parseJsonBlock<T>(content: string, type: string, fallback: T): T {
    const re = new RegExp(`<script\\s+type="${escapeRe(type)}"[^>]*>([\\s\\S]*?)<\\/script>`, 'i');
    const m = re.exec(content);
    if (!m) { return fallback; }
    try {
        return { ...fallback, ...JSON.parse(m[1].trim()) } as T;
    } catch {
        return fallback;
    }
}

function parseSlides(content: string): SlideData[] {
    const slides: SlideData[] = [];

    // Match each <script type="text/orz-slide" data-index="N"> block
    const scriptRe = /<script\s+type="text\/orz-slide"\s+data-index="(\d+)"[^>]*>([\s\S]*?)<\/script>/gi;

    let m: RegExpExecArray | null;
    while ((m = scriptRe.exec(content)) !== null) {
        const index = parseInt(m[1], 10);
        const source = m[2].trim();      // strip wrapping \n added by updateSlideSource
        const scriptEnd = m.index + m[0].length;

        // Find the next <section> after this script block
        const sectionHtml = extractNextSection(content, scriptEnd);

        slides.push({ index, source, sectionHtml });
    }

    return slides;
}

/**
 * Find the first <section> tag after `fromPos` and return its inner HTML.
 * Returns empty string if not found.
 */
function extractNextSection(content: string, fromPos: number): string {
    const openRe = /<section(\s[^>]*)?\s*>/gi;
    openRe.lastIndex = fromPos;
    const openM = openRe.exec(content);
    if (!openM) { return ''; }

    const innerStart = openM.index + openM[0].length;
    const innerEnd = findSectionClose(content, innerStart);

    return content.slice(innerStart, innerEnd);
}

/**
 * Find the index just before the closing </section> that corresponds to the
 * <section> whose inner content starts at `fromPos`.
 * Handles nested <section> elements.
 */
function findSectionClose(content: string, fromPos: number): number {
    let depth = 1;
    const tagRe = /<(\/?)section(\s[^>]*)?\s*>/gi;
    tagRe.lastIndex = fromPos;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(content)) !== null) {
        if (m[1] === '/') {
            depth--;
            if (depth === 0) {
                return m.index;
            }
        } else {
            depth++;
        }
    }
    return content.length;
}

// ─── Serialize ────────────────────────────────────────────────────────────────

/**
 * Update rendered section HTML in the file without touching anything else.
 * Also optionally update the orz-settings block.
 */
export function serializeSlidesFile(
    original: string,
    slideUpdates: { index: number; sectionHtml: string }[],
    settings?: Partial<DeckSettings>
): string {
    let result = original;

    // Update settings block if provided
    if (settings) {
        result = updateJsonBlock(result, 'text/orz-settings', settings);
    }

    // Apply slide section updates in reverse-index order so offsets stay valid
    const sorted = [...slideUpdates].sort((a, b) => b.index - a.index);

    for (const { index, sectionHtml } of sorted) {
        result = replaceSectionForSlide(result, index, sectionHtml);
    }

    return result;
}

/**
 * Replace the <section> that immediately follows the orz-slide script
 * with data-index=N.
 */
function replaceSectionForSlide(content: string, index: number, newInnerHtml: string): string {
    // Find the script block for this index
    const scriptRe = new RegExp(
        `(<script\\s+type="text\\/orz-slide"\\s+data-index="${index}"[^>]*>[\\s\\S]*?<\\/script>)`,
        'i'
    );
    const scriptM = scriptRe.exec(content);
    if (!scriptM) { return content; }

    const afterScript = scriptM.index + scriptM[0].length;

    // Find the next <section> opening tag
    const openRe = /<section(\s[^>]*)?\s*>/gi;
    openRe.lastIndex = afterScript;
    const openM = openRe.exec(content);
    if (!openM) { return content; }

    const sectionOpenEnd = openM.index + openM[0].length;
    const innerEnd = findSectionClose(content, sectionOpenEnd);

    // Replace only the inner HTML, keeping the <section ...> and </section> tags
    return content.slice(0, sectionOpenEnd) + '\n' + newInnerHtml + '\n' + content.slice(innerEnd);
}

/**
 * Update or insert a JSON script block in the file content.
 */
function updateJsonBlock(content: string, type: string, updates: Record<string, unknown>): string {
    const re = new RegExp(`(<script\\s+type="${escapeRe(type)}"[^>]*>)([\\s\\S]*?)(<\\/script>)`, 'i');
    const m = re.exec(content);
    if (!m) { return content; }

    let existing: Record<string, unknown> = {};
    try { existing = JSON.parse(m[2].trim()); } catch { /* use empty */ }

    const merged = { ...existing, ...updates };
    const newBlock = `${m[1]}\n${JSON.stringify(merged, null, 2)}\n${m[3]}`;

    return content.slice(0, m.index) + newBlock + content.slice(m.index + m[0].length);
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Inline a theme CSS string into the file content, replacing any existing
 * <link id="presentation-theme"> or <style id="presentation-theme"> tag.
 * This makes the output file self-contained (no external theme file needed).
 */
export function inlineThemeCss(content: string, themeName: string, themeCss: string): string {
    if (!themeCss) { return content; }
    const inlined = `<style id="presentation-theme" data-theme="${themeName}">\n${themeCss}\n</style>`;
    // Replace existing inline style block
    const styleRe = /<style\s[^>]*id="presentation-theme"[^>]*>[\s\S]*?<\/style>/gi;
    if (styleRe.test(content)) {
        styleRe.lastIndex = 0;
        return content.replace(styleRe, inlined);
    }
    // Replace <link ... id="presentation-theme" ...> (including trailing > or />)
    const linkRe = /<link\b[^>]*\bid="presentation-theme"[^>]*\/?>/gi;
    return content.replace(linkRe, inlined);
}

// ─── Update source for a slide ────────────────────────────────────────────────

/**
 * Replace the source text inside a <script type="text/orz-slide" data-index="N"> block.
 */
export function updateSlideSource(content: string, index: number, newSource: string): string {
    const re = new RegExp(
        `(<script\\s+type="text\\/orz-slide"\\s+data-index="${index}"[^>]*>)([\\s\\S]*?)(<\\/script>)`,
        'i'
    );
    const m = re.exec(content);
    if (!m) { return content; }
    return content.slice(0, m.index) + m[1] + '\n' + newSource.trim() + '\n' + m[3] + content.slice(m.index + m[0].length);
}
