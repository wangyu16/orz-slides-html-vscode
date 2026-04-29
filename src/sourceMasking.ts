export function maskMarkdownCode(source: string): string {
    let result = '';
    let pos = 0;

    while (pos < source.length) {
        const fenced = tryConsumeFence(source, pos);
        if (fenced) {
            result += maskNonNewlines(source.slice(pos, fenced.end));
            pos = fenced.end;
            continue;
        }

        const span = tryConsumeCodeSpan(source, pos);
        if (span) {
            result += maskNonNewlines(source.slice(pos, span.end));
            pos = span.end;
            continue;
        }

        result += source[pos];
        pos++;
    }

    return result;
}

function tryConsumeFence(source: string, pos: number): { end: number } | null {
    const marker = source[pos];
    if (marker !== '`' && marker !== '~') { return null; }
    if (!isFenceLineStart(source, pos)) { return null; }

    let fenceLen = 0;
    while (source[pos + fenceLen] === marker) {
        fenceLen++;
    }
    if (fenceLen < 3) { return null; }

    let scan = moveToNextLine(source, pos);
    while (scan < source.length) {
        if (isClosingFence(source, scan, marker, fenceLen)) {
            return { end: moveToNextLine(source, scan) };
        }
        scan = moveToNextLine(source, scan);
    }

    return { end: source.length };
}

function tryConsumeCodeSpan(source: string, pos: number): { end: number } | null {
    if (source[pos] !== '`') { return null; }

    let tickCount = 0;
    while (source[pos + tickCount] === '`') {
        tickCount++;
    }

    if (tickCount >= 3 && isFenceLineStart(source, pos)) {
        return null;
    }

    const fence = '`'.repeat(tickCount);
    const closeIdx = source.indexOf(fence, pos + tickCount);
    if (closeIdx === -1) { return null; }

    return { end: closeIdx + tickCount };
}

function isFenceLineStart(source: string, pos: number): boolean {
    let cursor = pos - 1;
    let spaces = 0;

    while (cursor >= 0 && source[cursor] !== '\n') {
        if (source[cursor] !== ' ') { return false; }
        spaces++;
        if (spaces > 3) { return false; }
        cursor--;
    }

    return true;
}

function isClosingFence(source: string, lineStart: number, marker: string, fenceLen: number): boolean {
    let pos = lineStart;
    let spaces = 0;
    while (source[pos] === ' ' && spaces < 3) {
        pos++;
        spaces++;
    }

    let count = 0;
    while (source[pos + count] === marker) {
        count++;
    }
    if (count < fenceLen) { return false; }

    pos += count;
    while (pos < source.length && source[pos] !== '\n') {
        if (source[pos] !== ' ' && source[pos] !== '\t') { return false; }
        pos++;
    }

    return true;
}

function moveToNextLine(source: string, pos: number): number {
    const newline = source.indexOf('\n', pos);
    return newline === -1 ? source.length : newline + 1;
}

function maskNonNewlines(chunk: string): string {
    return chunk.replace(/[^\n]/g, ' ');
}