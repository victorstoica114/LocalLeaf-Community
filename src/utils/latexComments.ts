export interface LatexCommentRemoval {
    content: string;
    removedLines: number;
    removedBlocks: number;
}

interface SourceLine {
    text: string;
    ending: string;
}

const PROTECTED_ENVIRONMENTS = new Set([
    'alltt',
    'BVerbatim',
    'filecontents',
    'filecontents*',
    'LVerbatim',
    'lstlisting',
    'minted',
    'SaveVerbatim',
    'Verbatim',
    'verbatim',
    'verbatim*',
]);

/**
 * Conservatively remove comments whose entire source line is a comment and
 * complete, standalone `comment` environments.
 *
 * Inline comments deliberately remain untouched: TeX can change the `%`
 * catcode, and removing them can join tokens or otherwise alter a document.
 * Line endings and ordinary blank lines are preserved exactly.
 */
export function removeStandaloneLatexComments(content: string): LatexCommentRemoval {
    const lines = splitSourceLines(content);
    const output: SourceLine[] = [];
    let protectedEnvironment: string | undefined;
    let pendingCommentBlock: SourceLine[] | undefined;
    let removedLines = 0;
    let removedBlocks = 0;

    for (const line of lines) {
        if (pendingCommentBlock) {
            pendingCommentBlock.push(line);
            if (isStandaloneEnvironmentBoundary(line.text, 'end', 'comment')) {
                removedLines += pendingCommentBlock.length;
                removedBlocks++;
                pendingCommentBlock = undefined;
            }
            continue;
        }

        if (protectedEnvironment) {
            output.push(line);
            if (isEnvironmentBoundary(line.text, 'end', protectedEnvironment)) {
                protectedEnvironment = undefined;
            }
            continue;
        }

        const openedEnvironment = getOpenedProtectedEnvironment(line.text);
        if (openedEnvironment) {
            protectedEnvironment = isEnvironmentBoundary(line.text, 'end', openedEnvironment)
                ? undefined
                : openedEnvironment;
            output.push(line);
            continue;
        }

        if (isStandaloneEnvironmentBoundary(line.text, 'begin', 'comment')) {
            pendingCommentBlock = [line];
            continue;
        }

        if (/^\s*%/.test(line.text)) {
            removedLines++;
            continue;
        }

        output.push(line);
    }

    // An unterminated comment environment may be ordinary text in a document
    // that does not load the `comment` package. Preserve it rather than
    // deleting the remainder of the file.
    if (pendingCommentBlock) output.push(...pendingCommentBlock);

    return {
        content: output.map(line => line.text + line.ending).join(''),
        removedLines,
        removedBlocks,
    };
}

function splitSourceLines(content: string): SourceLine[] {
    const lines: SourceLine[] = [];
    let start = 0;
    for (let index = 0; index < content.length; index++) {
        const character = content[index];
        if (character !== '\r' && character !== '\n') continue;

        const ending = character === '\r' && content[index + 1] === '\n' ? '\r\n' : character;
        lines.push({ text: content.slice(start, index), ending });
        if (ending.length === 2) index++;
        start = index + 1;
    }
    if (start < content.length) lines.push({ text: content.slice(start), ending: '' });
    return lines;
}

function getOpenedProtectedEnvironment(line: string): string | undefined {
    const match = /^\s*\\begin\s*\{\s*([^{}]+?)\s*\}/.exec(line);
    const environment = match?.[1];
    return environment && PROTECTED_ENVIRONMENTS.has(environment) ? environment : undefined;
}

function isEnvironmentBoundary(
    line: string,
    boundary: 'begin' | 'end',
    environment: string,
): boolean {
    const escapedEnvironment = escapeRegExp(environment);
    return new RegExp(`^\\s*\\\\${boundary}\\s*\\{\\s*${escapedEnvironment}\\s*\\}`).test(line);
}

function isStandaloneEnvironmentBoundary(
    line: string,
    boundary: 'begin' | 'end',
    environment: string,
): boolean {
    const escapedEnvironment = escapeRegExp(environment);
    return new RegExp(
        `^\\s*\\\\${boundary}\\s*\\{\\s*${escapedEnvironment}\\s*\\}\\s*(?:%.*)?$`,
    ).test(line);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
