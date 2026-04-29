import * as fs from 'fs';
import * as path from 'path';
import { DeckMeta } from '../types';
import { parseLayout } from '../layout/parser';
import { maskMarkdownCode } from '../sourceMasking';
import { renderLayoutNode } from './layoutRenderer';
import { renderMarkdown } from './markdownRenderer';
import {
    extractNyml,
    extractHeadings,
    extractH2,
    renderTitleSlide,
    renderSectionSlide,
    TitleSlideData,
    SectionSlideData,
    SlideFrameDecorations,
} from './templateEngine';

const SLIDE_STYLE_RESERVED_KEYS = new Set(['css', 'class', 'slideclass']);

export interface RenderSlideOptions {
    documentPath?: string;
}

// ─── Public interface ─────────────────────────────────────────────────────────

/**
 * Render a single slide source string to the inner HTML that belongs inside a
 * persisted Reveal `<section>...</section>`.
 *
 * @param source  Raw markdown + [[ ]] layout source from the orz-slide script block
 * @param deckMeta  Deck-level metadata (author, affiliation, date)
 * @param index   0-based slide index
 */
export async function renderSlide(
    source: string,
    deckMeta: DeckMeta,
    index: number,
    options: RenderSlideOptions = {}
): Promise<string> {
    // 1. Extract {{nyml}} block
    const { nymlData, strippedSource } = extractNyml(source);
    const decorations = buildSlideFrameDecorations(nymlData, index, options.documentPath);

    // Merge deck meta with slide-level nyml overrides
    const mergedMeta: DeckMeta = { ...deckMeta, ...nymlData };

    // 2. Detect slide type by presence of `# ` (h1) at top of stripped source.
    //    Strip code fences and inline code first so `# comment` inside a code
    //    block does not accidentally trigger the h1 match.
    const sourceForAnalysis = maskMarkdownCode(strippedSource);
    const hasH1 = /^#\s/m.test(sourceForAnalysis);
    const explicitTemplate = (nymlData['template'] ?? '').toLowerCase();
    const isTitleTemplate = explicitTemplate === 'centered'
        || explicitTemplate === 'split'
        || explicitTemplate === 'minimal';

    if (hasH1 && (index === 0 || isTitleTemplate)) {
        return renderPresentationTitle(strippedSource, mergedMeta, nymlData, decorations);
    }

    if (hasH1 && index > 0) {
        return renderSectionTitle(strippedSource, mergedMeta, nymlData, decorations);
    }

    // 3. Content slide
    return renderContentSlide(strippedSource, decorations);
}

// ─── Title slide (index === 0, has h1) ───────────────────────────────────────

async function renderPresentationTitle(
    source: string,
    meta: DeckMeta,
    nymlData: Record<string, string>,
    decorations: SlideFrameDecorations
): Promise<string> {
    const { h1, h2 } = extractHeadings(source);
    const template = (nymlData['template'] as TitleSlideData['template']) ?? 'centered';

    const data: TitleSlideData = {
        h1: h1 ?? 'Untitled',
        h2,
        author: meta.author,
        affiliation: meta.affiliation,
        date: meta.date,
        template,
    };

    return renderTitleSlide(data, decorations);
}

// ─── Section slide (index > 0, has h1) ───────────────────────────────────────

async function renderSectionTitle(
    source: string,
    meta: DeckMeta,
    nymlData: Record<string, string>,
    decorations: SlideFrameDecorations
): Promise<string> {
    const { h1, rest } = extractHeadings(source);
    const template = (nymlData['template'] as SectionSlideData['template']) ?? 'accent-band';
    const bodyHtml = rest.trim() ? await renderMarkdown(rest) : '';

    const data: SectionSlideData = {
        h1: h1 ?? 'Section',
        bodyHtml,
        template,
    };

    return renderSectionSlide(data, decorations);
}

// ─── Content slide ────────────────────────────────────────────────────────────

async function renderContentSlide(source: string, decorations: SlideFrameDecorations): Promise<string> {
    // Extract optional h2 heading for the header zone
    const { h2, rest } = extractH2(source);

    const headerHtml = h2
        ? `<div class="orz-header"><h2>${escHtml(h2)}</h2></div>\n`
        : '';

    // Parse and render layout
    const { tree, warnings } = parseLayout(rest);

    // Warn to console — callers can retrieve warnings via a more formal channel later
    for (const w of warnings) {
        console.warn(`[orz-slides layout] ${w.severity.toUpperCase()}: ${w.message}`);
    }

    const bodyHtml = await renderLayoutNode(tree);

    // Extract any <aside class="notes"> from the body HTML and move to end
    const { mainHtml, notesHtml } = separateNotes(bodyHtml);

    const rootClasses = decorations.rootClasses?.length ? ` ${decorations.rootClasses.join(' ')}` : '';
    const rootAttributes = decorations.rootAttributes ?? '';
    const styleHtml = decorations.styleHtml ?? '';

    return `${styleHtml}<div class="orz-slide-wrap${rootClasses}"${rootAttributes}>
${headerHtml}${mainHtml}
</div>
${notesHtml}`;
}

function buildSlideFrameDecorations(
    nymlData: Record<string, string>,
    index: number,
    documentPath?: string
): SlideFrameDecorations {
    const scopeId = `slide-${index}`;
    const rootClasses = collectSlideClasses(nymlData);
    const dataAttributes = [`data-orz-slide-scope="${escapeAttr(scopeId)}"`];
    const styleDeclarations: string[] = [];

    for (const [rawKey, rawValue] of Object.entries(nymlData)) {
        const key = normalizeToken(rawKey);
        if (!key || SLIDE_STYLE_RESERVED_KEYS.has(rawKey.toLowerCase())) { continue; }
        dataAttributes.push(`data-orz-${key}="${escapeAttr(rawValue)}"`);
        styleDeclarations.push(`--orz-nyml-${key}:${rawValue}`);
    }

    if (styleDeclarations.length) {
        dataAttributes.push(`style="${escapeAttr(styleDeclarations.join(';'))}"`);
    }

    const cssRef = nymlData['css']?.trim();
    const styleHtml = cssRef
        ? buildScopedSlideStyleTag(cssRef, scopeId, documentPath)
        : '';

    return {
        rootClasses,
        rootAttributes: dataAttributes.length ? ` ${dataAttributes.join(' ')}` : '',
        styleHtml,
    };
}

function collectSlideClasses(nymlData: Record<string, string>): string[] {
    return [nymlData['class'], nymlData['slideClass']]
        .filter((value): value is string => !!value)
        .flatMap(value => value.split(/\s+/))
        .map(value => value.trim())
        .filter(Boolean);
}

function buildScopedSlideStyleTag(cssRef: string, scopeId: string, documentPath?: string): string {
    const rawCss = resolveSlideCss(cssRef, documentPath);
    if (!rawCss) { return ''; }

    const scopedCss = rawCss.replace(/:slide\b/g, `[data-orz-slide-scope="${scopeId}"]`);

    return `<style data-orz-local-css="${escapeAttr(cssRef.split('\n', 1)[0].trim() || 'inline')}">\n${scopedCss}\n</style>\n`;
}

function resolveSlideCss(cssValue: string, documentPath?: string): string {
    const trimmed = cssValue.trim();
    if (!trimmed) { return ''; }

    if (trimmed.includes('\n') || trimmed.includes(':slide') || trimmed.includes('{') || trimmed.includes('}')) {
        return trimmed;
    }

    if (!documentPath) { return trimmed; }

    const documentDir = path.dirname(documentPath);
    const cssPath = path.isAbsolute(trimmed) ? trimmed : path.resolve(documentDir, trimmed);
    if (!fs.existsSync(cssPath)) {
        return trimmed;
    }

    const rawCss = fs.readFileSync(cssPath, 'utf8');
    return rewriteRelativeCssUrls(rawCss, path.dirname(cssPath), documentDir);
}

function rewriteRelativeCssUrls(css: string, cssDir: string, documentDir: string): string {
    return css.replace(/url\(([^)]+)\)/gi, (match, rawRef: string) => {
        const trimmed = rawRef.trim();
        const quote = trimmed[0] === '"' || trimmed[0] === '\'' ? trimmed[0] : '';
        const ref = quote && trimmed.endsWith(quote)
            ? trimmed.slice(1, -1)
            : trimmed;

        if (!ref || /^(data:|https?:|blob:|#|\/)/i.test(ref)) { return match; }

        const resolvedPath = path.resolve(cssDir, ref);
        const relativeToDocument = path.relative(documentDir, resolvedPath).split(path.sep).join('/');
        const normalized = relativeToDocument || path.basename(resolvedPath);
        const quoted = quote || '"';
        return `url(${quoted}${normalized}${quoted})`;
    });
}

function normalizeToken(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function escapeAttr(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Separate <aside class="notes"> elements from the rendered body HTML.
 * Returns { mainHtml, notesHtml }.
 */
function separateNotes(html: string): { mainHtml: string; notesHtml: string } {
    const noteParts: string[] = [];
    const mainHtml = html.replace(/<aside class="notes">([\s\S]*?)<\/aside>/gi, (_m, content) => {
        noteParts.push(content);
        return '';
    });

    const notesHtml = noteParts.length
        ? `<aside class="notes">${noteParts.join('\n')}</aside>`
        : '';

    return { mainHtml, notesHtml };
}

function escHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
