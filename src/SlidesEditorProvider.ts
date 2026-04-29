import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { parseSlidesFile, serializeSlidesFile, updateSlideSource, inlineThemeCss } from './fileIO';
import { SlidesFile, DeckSettings, PanelMessage, ExtMessage, InitMessage } from './types';
import { renderSlide } from './renderer/slideRenderer';

export class SlidesEditorProvider implements vscode.CustomTextEditorProvider {
    public static readonly viewType = 'orz-slides.editor';

    /** Tracks how many internal writes are in-flight per document URI.
     *  Prevents the onDidChangeTextDocument handler from treating our own
     *  writes as external edits and re-initialising the webview. */
    private readonly _ownWritePending = new Map<string, number>();

    constructor(private readonly context: vscode.ExtensionContext) {}

    // ─── resolveCustomTextEditor ───────────────────────────────────────────────

    public async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        // Bootstrap empty files before the webview loads so 'ready' always gets real content
        const raw = document.getText();
        const canonicalTemplate = readCanonicalTemplate(this.context.extensionPath);
        if (!raw.trim() || !/<script\s+type="text\/orz-slide"/i.test(raw)) {
            await this.bootstrapEmptyFile(document);
        } else if (needsOutputNormalization(raw, canonicalTemplate)) {
            await this.writeDocument(document, raw);
        }

        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.file(this.context.extensionPath),
                vscode.Uri.file(path.dirname(document.uri.fsPath)),
                ...((vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri)),
            ],
        };

        webviewPanel.webview.html = this.getWebviewHtml(webviewPanel.webview, document.uri);

        // ── Handle messages from webview ───────────────────────────────────────
        const disposable = webviewPanel.webview.onDidReceiveMessage(
            (msg: PanelMessage) => this.handleWebviewMessage(msg, document, webviewPanel.webview),
            undefined,
            this.context.subscriptions
        );

        // ── Handle external file changes ───────────────────────────────────────
        const changeDisposable = vscode.workspace.onDidChangeTextDocument(async (e) => {
            if (e.document.uri.toString() !== document.uri.toString()) { return; }
            if (e.contentChanges.length === 0) { return; }
            // Skip changes caused by our own writeDocument calls
            if ((this._ownWritePending.get(document.uri.toString()) ?? 0) > 0) { return; }
            // External edit — reload everything
            await this.sendFullInit(document, webviewPanel.webview);
        });

        webviewPanel.onDidDispose(() => {
            disposable.dispose();
            changeDisposable.dispose();
        });
    }

    // ─── Message handler ───────────────────────────────────────────────────────

    private async handleWebviewMessage(
        msg: PanelMessage,
        document: vscode.TextDocument,
        webview: vscode.Webview
    ): Promise<void> {
        switch (msg.type) {
            case 'ready': {
                await this.sendFullInit(document, webview);
                break;
            }

            case 'contentChanged': {
                // User edited slide source — re-render and send back
                const { index, source } = msg;
                try {
                    const file = parseSlidesFile(document.getText());
                    const html = await renderSlide(source, file.meta, index, { documentPath: document.uri.fsPath });
                    const docDir = path.dirname(document.uri.fsPath);
                    const previewHtml = inlineLocalImages(html, docDir);
                    const response: ExtMessage = { type: 'slideRendered', index, html: previewHtml };
                    webview.postMessage(response);
                } catch (err) {
                    console.error('[orz-slides] render error:', err);
                }
                break;
            }

            case 'saveFile': {
                // Persist source change and re-render to file
                const { index, source } = msg;
                try {
                    const original = document.getText();
                    const html = await renderSlide(source, parseSlidesFile(original).meta, index, { documentPath: document.uri.fsPath });
                    let updated = updateSlideSource(original, index, source);
                    updated = serializeSlidesFile(updated, [{ index, sectionHtml: html }]);
                    await this.writeDocument(document, updated);
                } catch (err) {
                    console.error('[orz-slides] save error:', err);
                }
                break;
            }

            case 'settingsChanged': {
                const { settings } = msg;
                try {
                    const updated = serializeSlidesFile(document.getText(), [], settings);
                    await this.writeDocument(document, updated);
                    const themeCss = readThemeCss(document.uri.fsPath, this.context.extensionPath, settings.theme);
                    const ack: ExtMessage = { type: 'settingsAck', settings, themeCss };
                    webview.postMessage(ack);
                } catch (err) {
                    console.error('[orz-slides] settings error:', err);
                }
                break;
            }

            case 'navigateTo': {
                // Navigation is fully handled in the webview — no extension action needed
                break;
            }

            case 'addSlide': {
                // Atomically flush any pending in-webview edit, then insert.
                await this.flushPendingEdit(document, msg.pendingIndex, msg.pendingSource);
                await this.insertSlide(document, msg.afterIndex);
                await this.sendFullInit(document, webview, msg.afterIndex + 1);
                break;
            }

            case 'deleteSlide': {
                // Flush pending edit for the current slide before deleting.
                await this.flushPendingEdit(document, msg.pendingIndex, msg.pendingSource);
                await this.deleteSlide(document, msg.index);
                const targetIdx = Math.max(0, msg.index - 1);
                await this.sendFullInit(document, webview, targetIdx);
                break;
            }
        }
    }

    // ─── Full init ─────────────────────────────────────────────────────────────

    private async sendFullInit(
        document: vscode.TextDocument,
        webview: vscode.Webview,
        selectIndex?: number
    ): Promise<void> {
        const content = document.getText();
        const file = parseSlidesFile(content);
        const canonicalTemplate = readCanonicalTemplate(this.context.extensionPath);
        const baseStylesCss = extractBaseStyles(canonicalTemplate) || extractBaseStyles(content);
        const themeCss = readThemeCss(document.uri.fsPath, this.context.extensionPath, file.settings.theme);
        const previewBaseHref = webview.asWebviewUri(vscode.Uri.file(path.dirname(document.uri.fsPath))).toString().replace(/\/?$/, '/');
        const docDir = path.dirname(document.uri.fsPath);
        const fileForPreview = {
            ...file,
            slides: file.slides.map(s => ({ ...s, sectionHtml: inlineLocalImages(s.sectionHtml, docDir) })),
        };
        const msg: InitMessage = { type: 'init', file: fileForPreview, baseStylesCss, themeCss, previewBaseHref, selectIndex };
        webview.postMessage(msg);
    }

    // ─── Document writes ───────────────────────────────────────────────────────

    private async writeDocument(document: vscode.TextDocument, content: string): Promise<void> {
        const canonicalTemplate = readCanonicalTemplate(this.context.extensionPath);
        const normalizedContent = normalizeOutputHtml(content);
        const file = parseSlidesFile(normalizedContent);
        const rebuiltContent = canonicalTemplate
            ? rebuildSlidesDocument(canonicalTemplate, file)
            : normalizedContent;
        const cleanedContent = normalizeOutputHtml(rebuiltContent);
        const themeCss = readThemeCss(document.uri.fsPath, this.context.extensionPath, file.settings.theme);
        const finalContent = themeCss
            ? inlineThemeCss(cleanedContent, file.settings.theme, themeCss)
            : cleanedContent;

        const uri = document.uri.toString();
        this._ownWritePending.set(uri, (this._ownWritePending.get(uri) ?? 0) + 1);
        try {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
                document.uri,
                new vscode.Range(0, 0, document.lineCount, 0),
                finalContent
            );
            await vscode.workspace.applyEdit(edit);
            await document.save();
        } finally {
            // Decrement after one event-loop tick — the change event fires synchronously
            // during applyEdit so by the time this executes the handler has already run.
            setImmediate(() => {
                const n = this._ownWritePending.get(uri) ?? 1;
                if (n <= 1) { this._ownWritePending.delete(uri); }
                else { this._ownWritePending.set(uri, n - 1); }
            });
        }
    }

    // ─── Flush pending webview edit ────────────────────────────────────────────

    /**
     * Persist a pending in-webview edit before performing a structural operation
     * (add/delete slide).  Mirrors the saveFile handler but is called inline so
     * the document is up-to-date before the structural mutation begins.
     */
    private async flushPendingEdit(
        document: vscode.TextDocument,
        index: number,
        source: string
    ): Promise<void> {
        try {
            const original = document.getText();
            const file = parseSlidesFile(original);
            const html = await renderSlide(source, file.meta, index, { documentPath: document.uri.fsPath });
            let updated = updateSlideSource(original, index, source);
            updated = serializeSlidesFile(updated, [{ index, sectionHtml: html }]);
            await this.writeDocument(document, updated);
        } catch (err) {
            console.error('[orz-slides] flushPendingEdit error:', err);
        }
    }

    // ─── Slide add / delete ────────────────────────────────────────────────────

    private async insertSlide(document: vscode.TextDocument, afterIndex: number): Promise<void> {
        const content = document.getText();
        const newIndex = afterIndex + 1;
        const newSource = `## New Slide\n\nContent goes here.\n`;
        const newHtml = `<div class="orz-slide-wrap">\n  <div class="orz-header"><h2>New Slide</h2></div>\n  <div class="orz-body orz-body-plain"><p>Content goes here.</p></div>\n</div>\n<aside class="notes"></aside>`;

        const scriptBlock = `<script type="text/orz-slide" data-index="${newIndex}">\n${newSource}\n</script>`;
        const sectionBlock = `<section>\n${newHtml}\n</section>`;
        const insertion = `\n\n    ${scriptBlock}\n    ${sectionBlock}`;

        // Find insertion point: after the <section> that follows the afterIndex script
        const scriptRe = new RegExp(
            `<script\\s+type="text\\/orz-slide"\\s+data-index="${afterIndex}"[^>]*>[\\s\\S]*?<\\/script>`,
            'i'
        );
        const scriptM = scriptRe.exec(content);
        if (!scriptM) { return; }

        const afterScript = scriptM.index + scriptM[0].length;
        const openRe = /<section(\s[^>]*)?\s*>/gi;
        openRe.lastIndex = afterScript;
        const openM = openRe.exec(content);
        if (!openM) { return; }
        const sectionOpenEnd = openM.index + openM[0].length;
        const innerEnd = this.findSectionClose(content, sectionOpenEnd);
        // innerEnd points to the start of </section>
        const closingTag = '</section>';
        const insertPos = innerEnd + closingTag.length;

        // Re-index all slides after afterIndex
        let updated = content.slice(0, insertPos) + insertion + this.reindexSlidesFrom(content.slice(insertPos), newIndex + 1);
        await this.writeDocument(document, updated);
    }

    private async deleteSlide(document: vscode.TextDocument, index: number): Promise<void> {
        const content = document.getText();

        // Find script block
        const scriptRe = new RegExp(
            `\\s*<script\\s+type="text\\/orz-slide"\\s+data-index="${index}"[^>]*>[\\s\\S]*?<\\/script>`,
            'i'
        );
        const scriptM = scriptRe.exec(content);
        if (!scriptM) { return; }

        const afterScript = scriptM.index + scriptM[0].length;
        const openRe = /<section(\s[^>]*)?\s*>/gi;
        openRe.lastIndex = afterScript;
        const openM = openRe.exec(content);
        if (!openM) { return; }

        const sectionStart = openM.index;
        const sectionOpenEnd = openM.index + openM[0].length;
        const innerEnd = this.findSectionClose(content, sectionOpenEnd);
        const sectionEnd = innerEnd + '</section>'.length;

        const before = content.slice(0, scriptM.index);
        const after = content.slice(sectionEnd);

        // Re-index remaining slides
        const updated = before + this.reindexSlidesFrom(after, index);
        await this.writeDocument(document, updated);
    }

    /** Re-index data-index attributes in content starting from `fromIndex`. */
    private reindexSlidesFrom(content: string, fromIndex: number): string {
        let counter = fromIndex;
        return content.replace(
            /<script\s+type="text\/orz-slide"\s+data-index="(\d+)"([^>]*)>/gi,
            (_match, _oldIdx, rest) => {
                return `<script type="text/orz-slide" data-index="${counter++}"${rest}>`;
            }
        );
    }

    private findSectionClose(content: string, fromPos: number): number {
        let depth = 1;
        const tagRe = /<(\/?)section(\s[^>]*)?\s*>/gi;
        tagRe.lastIndex = fromPos;
        let m: RegExpExecArray | null;
        while ((m = tagRe.exec(content)) !== null) {
            if (m[1] === '/') {
                depth--;
                if (depth === 0) { return m.index; }
            } else {
                depth++;
            }
        }
        return content.length;
    }

    // ─── Empty-file bootstrap ──────────────────────────────────────────────────

    /**
     * Write a minimal working .slides.html to an empty document.
     * Extracts the HTML shell from template.slides.html (CDN links + base-styles +
     * reveal.js init scripts) and adds a single blank content slide.
     */
    private async bootstrapEmptyFile(document: vscode.TextDocument): Promise<void> {
        const templatePath = path.join(this.context.extensionPath, 'template.slides.html');
        let template: string;
        try {
            template = fs.readFileSync(templatePath, 'utf8');
        } catch {
            // template.slides.html not found — write a bare-minimum stub so the
            // extension at least doesn't crash. The user can copy template.slides.html
            // manually as a starting point.
            await this.writeDocument(document, MINIMAL_STUB);
            return;
        }

        const shell = extractTemplatePrefix(template);
        const tail = extractTemplateTail(template);
        if (!shell || !tail) {
            await this.writeDocument(document, template);
            return;
        }

        const bootstrap =
`${shell}
            <script type="text/orz-settings">
{ "theme": "executive", "aspectRatio": "16:9", "transition": "slide" }
</script>
            <script type="text/orz-meta">
{ "author": "", "affiliation": "", "date": "" }
</script>

            <script type="text/orz-slide" data-index="0">
## New Slide

Content goes here.
</script>
            <section>
<div class="orz-slide-wrap">
  <div class="orz-header"><h2>New Slide</h2></div>
  <div class="orz-body orz-body-plain"><p>Content goes here.</p></div>
</div>
<aside class="notes"></aside>
            </section>${tail}`;

        await this.writeDocument(document, bootstrap);
    }

    // ─── Webview HTML ──────────────────────────────────────────────────────────

    private getWebviewHtml(webview: vscode.Webview, _documentUri: vscode.Uri): string {
        const panelJsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview', 'panel.js')
        );
        const nonce = getNonce();

        return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   style-src 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net;
                   font-src https://fonts.gstatic.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net;
                   script-src 'nonce-${nonce}' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com;
                   frame-src 'self' blob: data: https:;
                   img-src * data: blob:;
                   connect-src https:;">
    <title>ORZ Slides</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body, #app { height: 100%; overflow: hidden; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
        #app { display: flex; flex-direction: column; }
    </style>
</head>
<body>
    <div id="app">
        <div id="loading" style="display:flex;align-items:center;justify-content:center;height:100%;opacity:0.6;">
            Loading slides...
        </div>
    </div>
    <script nonce="${nonce}">window.__CSP_NONCE__ = '${nonce}';</script>
    <script nonce="${nonce}" src="${panelJsUri}"></script>
</body>
</html>`;
    }
}

function needsOutputNormalization(content: string, template: string): boolean {
    if (/<link\b[^>]*\bid="presentation-theme"/i.test(content) || /\borz-show-frames\b/.test(content)) {
        return true;
    }

    const templateBaseStyles = extractNamedBlock(template, 'style', 'base-styles');
    const currentBaseStyles = extractNamedBlock(content, 'style', 'base-styles');
    if (templateBaseStyles && templateBaseStyles !== currentBaseStyles) {
        return true;
    }

    const templateTail = extractTemplateTail(template);
    const currentTail = extractTemplateTail(content);
    return !!templateTail && templateTail !== currentTail;
}

function normalizeOutputHtml(content: string): string {
    return content.replace(/\sclass="([^"]*?)"/gi, (_match, classes: string) => {
        const filtered = classes
            .split(/\s+/)
            .filter(token => token && token !== 'orz-show-frames');

        return filtered.length ? ` class="${filtered.join(' ')}"` : '';
    });
}

function readCanonicalTemplate(extensionPath: string): string {
    try {
        return fs.readFileSync(path.join(extensionPath, 'template.slides.html'), 'utf8');
    } catch {
        return '';
    }
}

function extractNamedBlock(content: string, tagName: string, id: string): string {
    const re = new RegExp(`<${tagName}\\s+[^>]*id="${escapeRe(id)}"[^>]*>[\\s\\S]*?<\\/${tagName}>`, 'i');
    const match = re.exec(content);
    return match ? match[0] : '';
}

function extractTemplatePrefix(content: string): string {
    const anchor = content.search(/<script\s+type="text\/orz-(?:settings|meta|slide)"/i);
    return anchor === -1 ? '' : content.slice(0, anchor).trimEnd();
}

function extractTemplateTail(content: string): string {
    const lastSection = content.lastIndexOf('</section>');
    return lastSection === -1 ? '' : content.slice(lastSection + '</section>'.length);
}

function rebuildSlidesDocument(template: string, file: SlidesFile): string {
    let shell = extractTemplatePrefix(template);
    let tail = extractTemplateTail(template);
    if (!shell || !tail) {
        shell = extractTemplatePrefix(MINIMAL_STUB);
        tail = extractTemplateTail(MINIMAL_STUB);
    }

    if (!shell || !tail) {
        return template || MINIMAL_STUB;
    }

    const slidesBlock = file.slides.map((slide, index) => {
        const source = slide.source.trim();
        const sectionHtml = slide.sectionHtml.trim();
        return `            <script type="text/orz-slide" data-index="${index}">
${source}
</script>
            <section>
${sectionHtml}
            </section>`;
    }).join('\n\n');

    return `${shell}
            <script type="text/orz-settings">
${JSON.stringify(file.settings, null, 2)}
</script>
            <script type="text/orz-meta">
${JSON.stringify(file.meta, null, 2)}
</script>

${slidesBlock}${tail}`;
}

function escapeRe(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

/** Extract content of <style id="base-styles"> from a .slides.html document. */
function extractBaseStyles(content: string): string {
    const m = /<style\s+id="base-styles"[^>]*>([\s\S]*?)<\/style>/i.exec(content);
    return m ? m[1] : '';
}

/**
 * Replace relative/absolute local image `src` attributes in HTML with inline
 * base64 data URIs so they display correctly inside srcdoc preview iframes.
 * Remote URLs, data URIs, and blob URIs are left unchanged.
 */
function inlineLocalImages(html: string, docDir: string): string {
    return html.replace(/\bsrc="([^"]+)"/gi, (match, src: string) => {
        if (/^(https?|ftp|data|blob|javascript|mailto):/i.test(src)) { return match; }
        if (src.startsWith('#') || src.startsWith('vscode')) { return match; }
        try {
            const absPath = path.isAbsolute(src) ? src : path.resolve(docDir, src);
            const data = fs.readFileSync(absPath);
            const ext = path.extname(absPath).toLowerCase().slice(1);
            const mimeMap: Record<string, string> = {
                png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
                gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
                bmp: 'image/bmp', ico: 'image/x-icon',
            };
            const mime = mimeMap[ext] || 'application/octet-stream';
            return `src="data:${mime};base64,${data.toString('base64')}"`;
        } catch {
            return match; // file not found or unreadable — leave as-is
        }
    });
}

/** Read a theme CSS file from the document tree or extension fallback. */
function readThemeCss(docFsPath: string, extensionPath: string, theme: string): string {
    const themeFile = `theme-${theme}.css`;
    const searchDirs: string[] = [];

    let currentDir = path.dirname(docFsPath);
    while (true) {
        searchDirs.push(path.join(currentDir, 'themes'));
        const parent = path.dirname(currentDir);
        if (parent === currentDir) { break; }
        currentDir = parent;
    }

    searchDirs.push(path.join(extensionPath, 'themes'));

    for (const dir of searchDirs) {
        const themePath = path.join(dir, themeFile);
        try {
            if (fs.existsSync(themePath)) {
                return fs.readFileSync(themePath, 'utf8');
            }
        } catch {
            // keep searching
        }
    }

    return '';
}

/** Last-resort stub when template.slides.html is not available. */
const MINIMAL_STUB = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/reveal.js/5.0.4/reset.min.css">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/reveal.js/5.0.4/reveal.min.css">
<link rel="stylesheet" href="themes/theme-executive.css" id="presentation-theme" data-theme="executive">
<style id="base-styles">
.orz-slide-wrap{display:flex;flex-direction:column;height:100%;width:100%;box-sizing:border-box;padding:20px 36px;overflow:hidden}
.orz-header{flex:0 0 auto}.orz-body{flex:1 1 auto;overflow:hidden;display:flex}
.orz-body.orz-body-plain{display:block}.orz-body.orz-body-cols{flex-direction:row}
.orz-body.orz-body-rows{flex-direction:column}
.orz-col{flex:0 0 calc(var(--orz-frac,.5)*100%);overflow:hidden;display:flex;flex-direction:column;box-sizing:border-box;padding:0 8px}
.orz-row{flex:0 0 calc(var(--orz-frac,.5)*100%);overflow:hidden;width:100%;box-sizing:border-box;padding:4px 0}
.reveal h1,.reveal h2,.reveal h3{font-family:var(--font-heading,sans-serif);color:var(--heading-color,#222);background:var(--heading-bg,#eee);padding:10px 20px;margin-bottom:20px}
</style>
</head>
<body>
<div class="reveal"><div class="slides">
<script type="text/orz-settings">
{ "theme": "executive", "aspectRatio": "16:9", "transition": "slide" }
</script>
<script type="text/orz-meta">
{ "author": "", "affiliation": "", "date": "" }
</script>
<script type="text/orz-slide" data-index="0">
## New Slide

Content goes here.
</script>
<section>
<div class="orz-slide-wrap">
  <div class="orz-header"><h2>New Slide</h2></div>
  <div class="orz-body orz-body-plain"><p>Content goes here.</p></div>
</div>
<aside class="notes"></aside>
</section>
</div></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/reveal.js/5.0.4/reveal.min.js"></script>
<script>Reveal.initialize({center:false,width:1600,height:900,margin:0.04});</script>
</body>
</html>`;
