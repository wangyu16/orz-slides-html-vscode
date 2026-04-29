import { LayoutNode, ParseWarning } from '../types';
import { maskMarkdownCode } from '../sourceMasking';

// ─── Public interface ─────────────────────────────────────────────────────────

export interface ParseResult {
    tree: LayoutNode;
    warnings: ParseWarning[];
}

export function parseLayout(source: string): ParseResult {
    const parser = new LayoutParser(source);
    return parser.parse();
}

// ─── Parser ───────────────────────────────────────────────────────────────────

class LayoutParser {
    private pos = 0;
    private warnings: ParseWarning[] = [];
    private source: string;
    private masked: string;

    constructor(source: string) {
        this.source = source;
        this.masked = maskMarkdownCode(source);
    }

    parse(): ParseResult {
        const root: LayoutNode = { kind: 'root', children: [] };
        this.parseChildren(root, 0);

        // Validate sibling fractions at root level
        this.validateSiblingFracs(root.children, 0);

        return { tree: root, warnings: this.warnings };
    }

    // Parse children until we hit `]]` or end of string.
    // Returns the position after the closing `]]` (or at end of string).
    private parseChildren(parent: LayoutNode, depth: number): void {
        while (this.pos < this.source.length) {
            // Check for closing ]]
            if (this.masked.startsWith(']]', this.pos)) {
                this.pos += 2;
                return;
            }

            // Check for opening [[
            if (this.masked.startsWith('[[', this.pos)) {
                this.pos += 2;
                const node = this.parseElement(depth + 1);
                if ('children' in node) {
                    this.parseChildren(node as { kind: string; children: LayoutNode[] } & LayoutNode, depth + 1);
                }
                appendTo(parent, node);
            } else {
                // Collect text until [[ or ]] or end
                const textStart = this.pos;
                while (
                    this.pos < this.source.length &&
                    !this.masked.startsWith('[[', this.pos) &&
                    !this.masked.startsWith(']]', this.pos)
                ) {
                    this.pos++;
                }
                const text = this.source.slice(textStart, this.pos);
                if (text.trim()) {
                    appendTo(parent, { kind: 'text', source: text });
                }
            }
        }
    }

    /** Parse element name + optional [params] after `[[` has been consumed. */
    private parseElement(depth: number): LayoutNode {
        // Read element name: letters until [ or space or ]]
        const nameStart = this.pos;
        while (this.pos < this.source.length && /[a-z]/i.test(this.source[this.pos])) {
            this.pos++;
        }
        const name = this.source.slice(nameStart, this.pos).toLowerCase().trim();

        // Optional [params] block
        let paramStr = '';
        if (this.source[this.pos] === '[') {
            this.pos++; // consume [
            const paramStart = this.pos;
            while (this.pos < this.source.length && this.source[this.pos] !== ']') {
                this.pos++;
            }
            paramStr = this.source.slice(paramStart, this.pos);
            if (this.source[this.pos] === ']') { this.pos++; } // consume ]
        }

        // Skip whitespace after name/params
        while (this.pos < this.source.length && this.source[this.pos] === ' ') {
            this.pos++;
        }

        // Depth warning
        if (depth > 3) {
            this.warnings.push({
                message: `Layout depth ${depth} exceeds recommended maximum of 3`,
                depth,
                severity: 'warning',
            });
        }

        return this.buildNode(name, paramStr, depth);
    }

    private buildNode(name: string, paramStr: string, depth: number): LayoutNode {
        switch (name) {
            case 'col': {
                const frac = parseParam(paramStr, 0.5);
                return { kind: 'col', frac, children: [] };
            }
            case 'row': {
                const frac = parseParam(paramStr, 0.5);
                return { kind: 'row', frac, children: [] };
            }
            case 'center': {
                const width = parseParam(paramStr, 0.6);
                return { kind: 'center', width, children: [] };
            }
            case 'float': {
                const parts = paramStr.split(',').map(p => parseParam(p.trim(), 0));
                return {
                    kind: 'float',
                    x: parts[0] ?? 0,
                    y: parts[1] ?? 0,
                    w: parts[2] ?? 0.3,
                    children: [],
                };
            }
            case 'footer': {
                return { kind: 'footer', children: [] };
            }
            case 'note': {
                return { kind: 'note', children: [] };
            }
            default: {
                // Unknown element — silently ignore (user may still be typing a name).
                // Consume any content until the matching ]] so the parser stays in sync.
                return { kind: 'root', children: [] };
            }
        }
    }

    private validateSiblingFracs(children: LayoutNode[], depth: number): void {
        // Check col siblings
        const cols = children.filter(n => n.kind === 'col') as { kind: 'col'; frac: number; children: LayoutNode[] }[];
        if (cols.length > 1) {
            const sum = cols.reduce((acc, c) => acc + c.frac, 0);
            if (sum > 1.005) {
                this.warnings.push({
                    message: `Column fractions sum to ${sum.toFixed(2)} (> 1.0). Columns will overflow.`,
                    depth,
                    severity: 'error',
                });
            }
        }

        // Check row siblings
        const rows = children.filter(n => n.kind === 'row') as { kind: 'row'; frac: number; children: LayoutNode[] }[];
        if (rows.length > 1) {
            const sum = rows.reduce((acc, r) => acc + r.frac, 0);
            if (sum > 1.005) {
                this.warnings.push({
                    message: `Row fractions sum to ${sum.toFixed(2)} (> 1.0). Rows will overflow.`,
                    depth,
                    severity: 'error',
                });
            }
        }

        // Recurse into children
        for (const child of children) {
            if ('children' in child) {
                this.validateSiblingFracs((child as { children: LayoutNode[] }).children, depth + 1);
            }
        }
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse a parameter string to a number [0..1].
 * Accepts: "50%" → 0.5, "1/2" → 0.5, "0.5" → 0.5, "3" → 3 (for large values like pixel-based)
 */
export function parseParam(s: string, fallback: number): number {
    s = s.trim();
    if (!s) { return fallback; }

    // Percentage
    if (s.endsWith('%')) {
        const v = parseFloat(s);
        if (!isNaN(v)) { return v / 100; }
    }

    // Fraction a/b
    const slashIdx = s.indexOf('/');
    if (slashIdx !== -1) {
        const a = parseFloat(s.slice(0, slashIdx));
        const b = parseFloat(s.slice(slashIdx + 1));
        if (!isNaN(a) && !isNaN(b) && b !== 0) { return a / b; }
    }

    // Plain number
    const v = parseFloat(s);
    if (!isNaN(v)) { return v; }

    return fallback;
}

function appendTo(parent: LayoutNode, child: LayoutNode): void {
    if ('children' in parent) {
        (parent as { children: LayoutNode[] }).children.push(child);
    }
}
