import * as vscode from 'vscode';

// ─── Type stub for the orz-md-preview API ────────────────────────────────────
// The real API is provided by the yuwang26.orz-md-preview extension at runtime.

interface OrzMdPreviewApi {
    renderMarkdownHtml(source: string): Promise<string>;
}

// ─── Renderer ─────────────────────────────────────────────────────────────────

let _api: OrzMdPreviewApi | undefined;
let _initAttempts = 0;

async function getApi(): Promise<OrzMdPreviewApi | undefined> {
    if (_api) { return _api; }
    if (_initAttempts >= 5) { return undefined; }

    const ext = vscode.extensions.getExtension<OrzMdPreviewApi>('yuwang26.orz-md-preview');
    if (!ext) { return undefined; }

    _initAttempts++;
    try {
        _api = await ext.activate();
        return _api;
    } catch {
        // Will retry next call
        return undefined;
    }
}

/**
 * Render a markdown string to an HTML fragment ready for insertion inside
 * a .reveal <section>.
 *
 * The orz-md-preview API returns `<article class="markdown-body">...</article>`.
 * Keep that wrapper so saved output matches orz-markdown's expected DOM shape.
 */
export async function renderMarkdown(source: string): Promise<string> {
    const api = await getApi();
    if (!api) {
        // Fallback: minimal HTML with escaped content for robustness
        return `<article class="markdown-body"><p style="color:#888;font-size:0.8em;">[orz-md-preview unavailable — raw source shown]</p><pre>${escapeHtml(source)}</pre></article>`;
    }

    const html = await api.renderMarkdownHtml(source);

    return ensureMarkdownBodyWrapper(normalizeRenderedHtml(html));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ensureMarkdownBodyWrapper(html: string): string {
    // Match <article ...> or <div ...> with class="markdown-body"
    const openRe = /^<(?:article|div)[^>]*class="[^"]*markdown-body[^"]*"[^>]*>/i;
    return openRe.test(html.trim()) ? html : `<article class="markdown-body">${html}</article>`;
}

function normalizeRenderedHtml(html: string): string {
    return applyLegacyLeadingClassMarkers(html
        .replace(/\bclassname\s*=/gi, 'class=')
        .replace(/\bclassName\s*=/g, 'class='));
}

function applyLegacyLeadingClassMarkers(html: string): string {
    return html.replace(
        /<(li|p|div|blockquote|h[1-6])(\b[^>]*)>\s*\{\s*((?:\.[\w-]+\s*)+)\}\s*/gi,
        (_match, tagName: string, attrs: string, classList: string) => {
            const classes = classList
                .trim()
                .split(/\s+/)
                .map(token => token.replace(/^\./, ''))
                .filter(Boolean);

            return `<${tagName}${appendClasses(attrs, classes)}>`;
        }
    );
}

function appendClasses(attrs: string, classesToAdd: string[]): string {
    if (!classesToAdd.length) { return attrs; }

    const classAttrRe = /\bclass="([^"]*)"/i;
    const classMatch = classAttrRe.exec(attrs);
    if (!classMatch) {
        return ` class="${classesToAdd.join(' ')}"${attrs}`;
    }

    const merged = new Set(
        classMatch[1]
            .split(/\s+/)
            .concat(classesToAdd)
            .filter(Boolean)
    );

    return attrs.replace(classAttrRe, `class="${Array.from(merged).join(' ')}"`);
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
