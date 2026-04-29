import { DeckMeta } from '../types';
import { renderMarkdown } from './markdownRenderer';
import { maskMarkdownCode } from '../sourceMasking';

// ─── Template Engine ──────────────────────────────────────────────────────────
// Renders presentation title slides and section title slides from built-in
// templates. Template selection is driven by the `template` field in the
// slide's {{nyml}} block (defaults listed below).

// ─── Presentation title slide ─────────────────────────────────────────────────

export interface TitleSlideData {
    h1: string;
    h2?: string;
    author?: string;
    affiliation?: string;
    date?: string;
    template: 'centered' | 'split' | 'minimal';
}

export interface SlideFrameDecorations {
    rootClasses?: string[];
    rootAttributes?: string;
    styleHtml?: string;
}

export async function renderTitleSlide(
    data: TitleSlideData,
    decorations: SlideFrameDecorations = {}
): Promise<string> {
    const tpl = data.template ?? 'centered';
    const inner = buildTitleInner(data);
    const splitAside = tpl === 'split'
        ? `
    <div class="orz-title-split-aside">
        <p style="color:#fff; font-size:1.4em; font-weight:600; text-align:center; line-height:1.6; margin:0; opacity:0.92;">Replace this aside with a figure, logo, or decorative element.</p>
    </div>`
        : '';
    const rootClasses = decorations.rootClasses?.length ? ` ${decorations.rootClasses.join(' ')}` : '';
    const rootAttributes = decorations.rootAttributes ?? '';
    const styleHtml = decorations.styleHtml ?? '';
    return `${styleHtml}<div class="orz-title-slide tpl-${tpl}${rootClasses}"${rootAttributes}>
${inner}${splitAside}
</div>`;
}

function buildTitleInner(data: TitleSlideData): string {
    const subtitle = data.h2 ? `\n        <p class="title-subtitle">${esc(data.h2)}</p>` : '';
    const metaParts = [data.author, data.affiliation, data.date]
        .filter((value): value is string => !!value)
        .map(esc);
    const meta = metaParts.length
        ? `\n        <div class="orz-title-meta">\n            <p class="title-author">${metaParts.join(' &nbsp;·&nbsp; ')}</p>\n        </div>`
        : '';

    return `    <div class="orz-title-main">\n        <h1 class="title-heading">${esc(data.h1)}</h1>${subtitle}${meta}\n    </div>`;
}

// ─── Section title slide ──────────────────────────────────────────────────────

export interface SectionSlideData {
    h1: string;
    bodyHtml: string;
    template: 'accent-band' | 'sidebar' | 'minimal';
}

export async function renderSectionSlide(
    data: SectionSlideData,
    decorations: SlideFrameDecorations = {}
): Promise<string> {
    const tpl = data.template ?? 'accent-band';
    const rootClasses = decorations.rootClasses?.length ? ` ${decorations.rootClasses.join(' ')}` : '';
    const rootAttributes = decorations.rootAttributes ?? '';
    const styleHtml = decorations.styleHtml ?? '';

    if (tpl === 'sidebar') {
        return `${styleHtml}<div class="orz-section-slide tpl-sidebar${rootClasses}"${rootAttributes}>
    <div class="orz-section-stripe"></div>
    <div class="orz-section-body">
        <h1>${esc(data.h1)}</h1>
        ${data.bodyHtml}
    </div>
</div>`;
    }

    // accent-band (default) and minimal
    return `${styleHtml}<div class="orz-section-slide tpl-${tpl}${rootClasses}"${rootAttributes}>
    <div class="orz-section-band">
        <h1>${esc(data.h1)}</h1>
    </div>
    <div class="orz-section-body">
        ${data.bodyHtml}
    </div>
</div>`;
}

// ─── Metadata extraction ──────────────────────────────────────────────────────

/**
 * Extract h1 text and optional h2 text from stripped markdown source.
 * Returns { h1, h2, rest } where rest is the markdown after the headings.
 */
export function extractHeadings(source: string): {
    h1: string | undefined;
    h2: string | undefined;
    rest: string;
} {
    const lines = source.split('\n');
    const maskedLines = maskMarkdownCode(source).split('\n');
    let h1: string | undefined;
    let h2: string | undefined;
    let consumed = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const maskedLine = maskedLines[i] ?? '';
        if (!h1 && /^#\s/.test(maskedLine)) {
            h1 = line.replace(/^#\s+/, '').trim();
            consumed = i + 1;
        } else if (h1 && !h2 && /^##\s/.test(maskedLine)) {
            h2 = line.replace(/^##\s+/, '').trim();
            consumed = i + 1;
        } else if (line.trim() && consumed > 0) {
            break;
        }
    }

    const rest = lines.slice(consumed).join('\n').trimStart();
    return { h1, h2, rest };
}

/**
 * Extract h2 from the start of markdown source.
 * Returns { h2, rest }.
 */
export function extractH2(source: string): { h2: string | undefined; rest: string } {
    // Skip any leading blank lines so "## Title" is recognised even when blank
    // lines precede it (e.g. after nyml block extraction leaves whitespace).
    const lines = source.split('\n');
    const maskedLines = maskMarkdownCode(source).split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const maskedLine = maskedLines[i] ?? '';
        if (maskedLine.trim() === '') { continue; }     // skip blank lines
        if (/^##\s/.test(maskedLine)) {
            return {
                h2: line.replace(/^##\s+/, '').trim(),
                rest: lines.slice(i + 1).join('\n').trimStart(),
            };
        }
        break;                                          // first non-blank line is not ##
    }
    return { h2: undefined, rest: source };
}

/**
 * Extract {{nyml ...}} block from source, parse to JSON, return
 * { nymlData, strippedSource }.
 */
export function extractNyml(source: string): {
    nymlData: Record<string, string>;
    strippedSource: string;
} {
    const re = /\{\{nyml([\s\S]*?)\}\}/;
    const m = re.exec(source);
    if (!m) { return { nymlData: {}, strippedSource: source }; }

    const nymlData = parseNyml(m[1]);
    const strippedSource = (source.slice(0, m.index) + source.slice(m.index + m[0].length)).trim();
    return { nymlData, strippedSource };
}

/**
 * NYML parser for slide metadata.
 * Supports flat string key/value pairs plus multiline `key: |` literal blocks,
 * which is enough for title metadata and inline slide-local CSS.
 */
function parseNyml(raw: string): Record<string, string> {
    const result: Record<string, string> = {};
    const lines = raw.replace(/\r\n?/g, '\n').split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) { continue; }

        const parsed = parseNymlKeyValue(line);
        if (!parsed) { continue; }

        const { indent, key, value } = parsed;
        if (value === '|') {
            const blockLines: string[] = [];
            let firstContentIndent: number | undefined;

            while (i + 1 < lines.length) {
                const nextLine = lines[i + 1];
                const nextIndent = countIndent(nextLine);
                const nextTrimmed = nextLine.trim();

                if (nextTrimmed && nextIndent <= indent) {
                    break;
                }

                i++;
                if (!nextTrimmed) {
                    blockLines.push('');
                    continue;
                }

                if (firstContentIndent === undefined) {
                    firstContentIndent = nextIndent;
                }
                const dedent = firstContentIndent ?? 0;
                blockLines.push(nextLine.slice(Math.min(dedent, nextLine.length)));
            }

            result[key] = blockLines.join('\n');
            continue;
        }

        result[key] = value;
    }

    return result;
}

function parseNymlKeyValue(line: string): { indent: number; key: string; value: string } | undefined {
    const indent = countIndent(line);
    const body = line.slice(indent);

    if (body.startsWith('"')) {
        const endQuote = body.indexOf('"', 1);
        if (endQuote === -1 || body[endQuote + 1] !== ':') { return undefined; }
        const key = body.slice(1, endQuote);
        const value = body.slice(endQuote + 2).trim();
        return { indent, key, value };
    }

    const colon = body.indexOf(':');
    if (colon === -1) { return undefined; }

    const key = body.slice(0, colon).trim();
    const value = body.slice(colon + 1).trim();
    if (!key) { return undefined; }
    return { indent, key, value };
}

function countIndent(line: string): number {
    let indent = 0;
    while (indent < line.length && line[indent] === ' ') {
        indent++;
    }
    return indent;
}

function esc(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
