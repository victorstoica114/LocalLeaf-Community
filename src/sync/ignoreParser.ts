/**
 * LocalLeaf Ignore Parser
 * Parses .leafignore files with support for $MAIN_TEX and $MAIN_PDF variables
 */

import * as vscode from 'vscode';
import { Minimatch } from 'minimatch';
import { IGNORE_FILE, VAR_MAIN_TEX, VAR_MAIN_PDF, DEFAULT_IGNORE_PATTERNS } from '../consts';
import { ProjectSettings } from '../utils/settingsManager';
import { assertSafeWorkspacePath, isFileNotFoundError } from '../utils/pathSafety';

export const MAX_IGNORE_FILE_BYTES = 1024 * 1024;
export const MAX_IGNORE_PATTERNS = 10_000;
export const MAX_IGNORE_PATTERN_LENGTH = 4096;

function validateIgnorePatterns(patterns: readonly string[]): string[] {
    if (patterns.length > MAX_IGNORE_PATTERNS) {
        throw new Error('The .leafignore file contains too many patterns.');
    }
    const validated = patterns.map(pattern => {
        if (
            typeof pattern !== 'string'
            || pattern.length > MAX_IGNORE_PATTERN_LENGTH
            || pattern.includes('\0')
        ) {
            throw new Error('The .leafignore file contains an invalid or oversized pattern.');
        }
        return pattern;
    });
    const encodedSize = new TextEncoder().encode(`${validated.join('\n')}\n`).byteLength;
    if (encodedSize > MAX_IGNORE_FILE_BYTES) {
        throw new Error('The .leafignore file exceeds the size limit.');
    }
    return validated;
}

function escapeGlobLiteral(value: string): string {
    return value.replace(/([*?\[\]{}()!+@\\])/g, '\\$1');
}

/**
 * Ignore Parser - handles .leafignore patterns
 */
export class IgnoreParser {
    private patterns: string[] = [];
    private resolvedPatterns: string[] = [];
    private compiledPatterns: Array<{ negated: boolean; anchored: Minimatch; relative: Minimatch }> = [];

    constructor(
        private readonly workspaceFolder: vscode.Uri,
        private settings?: ProjectSettings
    ) {}

    /**
     * Get the path to .leafignore file
     */
    private getIgnoreFilePath(): vscode.Uri {
        return vscode.Uri.joinPath(this.workspaceFolder, IGNORE_FILE);
    }

    /**
     * Load patterns from .leafignore file
     */
    async load(): Promise<void> {
        try {
            const ignoreFilePath = this.getIgnoreFilePath();
            await assertSafeWorkspacePath(this.workspaceFolder, ignoreFilePath);
            const stat = await vscode.workspace.fs.stat(ignoreFilePath);
            if (
                !Number.isSafeInteger(stat.size)
                || stat.size < 0
                || stat.size > MAX_IGNORE_FILE_BYTES
            ) {
                throw new Error('The .leafignore file exceeds the size limit.');
            }
            const content = await vscode.workspace.fs.readFile(ignoreFilePath);
            if (content.byteLength > MAX_IGNORE_FILE_BYTES) {
                throw new Error('The .leafignore file exceeds the size limit.');
            }
            const text = new TextDecoder().decode(content);
            this.patterns = this.parseIgnoreFile(text);
        } catch (error) {
            if (!isFileNotFoundError(error)) throw error;
            this.patterns = [...DEFAULT_IGNORE_PATTERNS];
        }
        this.resolveVariables();
    }

    /**
     * Parse .leafignore file content
     */
    private parseIgnoreFile(content: string): string[] {
        return validateIgnorePatterns(content
            .split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#'))); // Remove empty lines and comments
    }

    /**
     * Resolve variables like $MAIN_TEX and $MAIN_PDF
     */
    private resolveVariables(): void {
        this.resolvedPatterns = this.patterns.flatMap(pattern => {
            let resolved = pattern;

            // Resolve $MAIN_TEX
            if (resolved.includes(VAR_MAIN_TEX)) {
                if (!this.settings?.mainTex) return [];
                resolved = resolved.replace(VAR_MAIN_TEX, escapeGlobLiteral(this.settings.mainTex));
            }

            // Resolve $MAIN_PDF
            if (resolved.includes(VAR_MAIN_PDF)) {
                if (!this.settings?.mainPdf) return [];
                resolved = resolved.replace(VAR_MAIN_PDF, escapeGlobLiteral(this.settings.mainPdf));
            }

            return [resolved];
        });
        this.compiledPatterns = this.resolvedPatterns.flatMap(rawPattern => {
            const negated = rawPattern.startsWith('!');
            const pattern = negated ? rawPattern.slice(1) : rawPattern;
            if (!pattern) return [];
            const options = { dot: true, nonegate: true };
            return [{
                negated,
                anchored: new Minimatch(pattern.startsWith('/') ? pattern : '**/' + pattern, options),
                relative: new Minimatch(pattern, options),
            }];
        });
    }

    /**
     * Update settings (e.g., when mainTex/mainPdf changes)
     */
    updateSettings(settings: ProjectSettings): void {
        this.settings = settings;
        this.resolveVariables();
    }

    /**
     * Check if a path should be ignored
     */
    shouldIgnore(relativePath: string): boolean {
        // Normalize path (ensure it starts with /)
        const normalizedPath = relativePath.startsWith('/') ? relativePath : '/' + relativePath;
        const candidates = [normalizedPath];
        // A directory rule also applies to every descendant. Socket events and
        // bulk pulls visit files directly, without first visiting their parent.
        for (let index = normalizedPath.indexOf('/', 1); index >= 0; index = normalizedPath.indexOf('/', index + 1)) {
            if (index < normalizedPath.length - 1) candidates.push(normalizedPath.slice(0, index + 1));
        }
        let ignored = false;

        for (const rule of this.compiledPatterns) {
            if (candidates.some(candidate =>
                rule.anchored.match(candidate) || rule.relative.match(candidate.slice(1))
            )) {
                ignored = !rule.negated;
            }
        }

        return ignored;
    }

    /**
     * Get all patterns (raw, unresolved)
     */
    getPatterns(): string[] {
        return [...this.patterns];
    }

    /**
     * Get resolved patterns
     */
    getResolvedPatterns(): string[] {
        return [...this.resolvedPatterns];
    }

    /**
     * Save patterns to .leafignore file
     */
    async save(patterns: string[]): Promise<void> {
        const validatedPatterns = validateIgnorePatterns(patterns);
        const content = validatedPatterns.join('\n') + '\n';
        const ignoreFilePath = this.getIgnoreFilePath();
        await assertSafeWorkspacePath(this.workspaceFolder, ignoreFilePath);
        await vscode.workspace.fs.writeFile(
            ignoreFilePath,
            new TextEncoder().encode(content)
        );
        this.patterns = validatedPatterns;
        this.resolveVariables();
    }

    /**
     * Create a default .leafignore file
     */
    async createDefault(): Promise<void> {
        const defaultContent = `# LocalLeaf Ignore File
# Patterns work like .gitignore
# Use $MAIN_PDF to reference the main PDF file from settings

# Don't sync the compiled PDF (prevents corruption during local compile)
$MAIN_PDF

# Hidden files and directories
.*
.*/**

# LaTeX build artifacts
*.aux
*.bbl
*.bcf
*.blg
*.fdb_latexmk
*.fls
*.log
*.out
*.run.xml
*.synctex.gz
*.synctex(busy)
*.toc
*.lof
*.lot
*.xdv

# LocalLeaf config directory
.localleaf/**
`;
        const ignoreFilePath = this.getIgnoreFilePath();
        await assertSafeWorkspacePath(this.workspaceFolder, ignoreFilePath);
        await vscode.workspace.fs.writeFile(
            ignoreFilePath,
            new TextEncoder().encode(defaultContent)
        );
        await this.load();
    }

    /**
     * Check if .leafignore file exists
     */
    async exists(): Promise<boolean> {
        try {
            const ignoreFilePath = this.getIgnoreFilePath();
            await assertSafeWorkspacePath(this.workspaceFolder, ignoreFilePath);
            await vscode.workspace.fs.stat(ignoreFilePath);
            return true;
        } catch (error) {
            if (!isFileNotFoundError(error)) throw error;
            return false;
        }
    }

    /**
     * Add a pattern to the ignore file
     */
    async addPattern(pattern: string): Promise<void> {
        if (!this.patterns.includes(pattern)) {
            await this.save([...this.patterns, pattern]);
        }
    }

    /**
     * Remove a pattern from the ignore file
     */
    async removePattern(pattern: string): Promise<void> {
        const index = this.patterns.indexOf(pattern);
        if (index !== -1) {
            await this.save(this.patterns.filter((_, candidateIndex) => candidateIndex !== index));
        }
    }
}

/**
 * Create a watcher for .leafignore file changes
 */
export function createIgnoreWatcher(
    workspaceFolder: vscode.Uri,
    onIgnoreChanged: () => void
): vscode.FileSystemWatcher {
    const pattern = new vscode.RelativePattern(workspaceFolder, IGNORE_FILE);
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    watcher.onDidChange(onIgnoreChanged);
    watcher.onDidCreate(onIgnoreChanged);
    watcher.onDidDelete(onIgnoreChanged);

    return watcher;
}
