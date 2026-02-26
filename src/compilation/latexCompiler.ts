/**
 * LocalLeaf LaTeX Compiler
 * Detects and runs LaTeX compilers, parses output for errors.
 * Build artifacts go into .localleaf/build/ to keep the workspace clean.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ChildProcess, spawn } from 'child_process';
import { CONFIG_DIR } from '../consts';

export type CompilerType = 'latexmk' | 'pdflatex' | 'xelatex' | 'lualatex';

/** Subdirectory inside .localleaf/ for build artifacts */
const BUILD_DIR = 'build';

export interface CompilationResult {
    success: boolean;
    pdfPath?: string;
    errors: CompilationError[];
    warnings: string[];
    duration: number;
}

export interface CompilationError {
    file: string;
    line: number;
    message: string;
}

export class LatexCompiler implements vscode.Disposable {
    private currentProcess: ChildProcess | undefined;
    private diagnosticCollection: vscode.DiagnosticCollection;

    constructor() {
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection('localleaf-latex');
    }

    /**
     * Detect which compilers are available on the system
     */
    async detectCompilers(): Promise<CompilerType[]> {
        const compilers: CompilerType[] = ['latexmk', 'pdflatex', 'xelatex', 'lualatex'];
        const available: CompilerType[] = [];

        for (const compiler of compilers) {
            if (await this.isAvailable(compiler)) {
                available.push(compiler);
            }
        }

        return available;
    }

    private async isAvailable(command: string): Promise<boolean> {
        return new Promise(resolve => {
            const cmd = process.platform === 'win32' ? 'where' : 'which';
            const proc = spawn(cmd, [command], { stdio: 'pipe', shell: true });
            proc.on('close', code => resolve(code === 0));
            proc.on('error', () => resolve(false));
            setTimeout(() => { proc.kill(); resolve(false); }, 3000);
        });
    }

    /**
     * Get the build output directory for a workspace
     */
    static getBuildDir(workspaceFolder: string): string {
        return path.join(workspaceFolder, CONFIG_DIR, BUILD_DIR);
    }

    /**
     * Execute LaTeX compilation.
     * Outputs go to .localleaf/build/ so the workspace stays clean.
     */
    async compile(workspaceFolder: string, mainTex: string, compiler?: CompilerType): Promise<CompilationResult> {
        const startTime = Date.now();
        let selectedCompiler = compiler || 'latexmk';

        // Auto-detect: try latexmk first, then fall back to pdflatex
        if (!compiler) {
            const available = await this.isAvailable(selectedCompiler);
            if (!available) {
                selectedCompiler = 'pdflatex';
                const pdfAvailable = await this.isAvailable(selectedCompiler);
                if (!pdfAvailable) {
                    return {
                        success: false,
                        errors: [{ file: mainTex, line: 0, message: 'No LaTeX compiler found. Please install TeX Live, MiKTeX, or another TeX distribution.' }],
                        warnings: [],
                        duration: Date.now() - startTime,
                    };
                }
            }
        } else {
            const available = await this.isAvailable(selectedCompiler);
            if (!available) {
                return {
                    success: false,
                    errors: [{ file: mainTex, line: 0, message: `Compiler "${selectedCompiler}" not found. Please install it or choose a different compiler.` }],
                    warnings: [],
                    duration: Date.now() - startTime,
                };
            }
        }

        // Ensure build directory exists
        const buildDir = LatexCompiler.getBuildDir(workspaceFolder);
        fs.mkdirSync(buildDir, { recursive: true });

        // Build command arguments (with output directory)
        const args = this.buildArgs(selectedCompiler, mainTex, buildDir);

        return new Promise((resolve) => {
            let stdout = '';
            let stderr = '';

            const proc = spawn(selectedCompiler, args, {
                cwd: workspaceFolder,
                shell: true,
                stdio: 'pipe',
            });

            this.currentProcess = proc;

            proc.stdout?.on('data', (data: Buffer) => {
                stdout += data.toString();
            });

            proc.stderr?.on('data', (data: Buffer) => {
                stderr += data.toString();
            });

            proc.on('close', (code) => {
                this.currentProcess = undefined;
                const duration = Date.now() - startTime;

                // Parse log file for errors (log is now in build dir)
                const logFile = mainTex.replace(/\.tex$/, '.log');
                const logPath = path.join(buildDir, logFile);
                this.parseLogFile(logPath, workspaceFolder).then(({ errors, warnings }) => {
                    // The PDF will be in the build directory
                    const pdfFile = mainTex.replace(/\.tex$/, '.pdf');
                    const pdfPath = path.join(buildDir, pdfFile);

                    // Check if PDF was actually generated —
                    // some compilers (e.g. MiKTeX) exit with non-zero code
                    // due to warnings even when compilation succeeds
                    const pdfExists = fs.existsSync(pdfPath);
                    const actuallySucceeded = pdfExists && (code === 0 || errors.length === 0);

                    // If the process failed and we found no errors in the log,
                    // include stderr/stdout so the user can see what went wrong
                    if (!actuallySucceeded && errors.length === 0) {
                        const output = (stderr || stdout).trim();
                        if (output) {
                            const lastLines = output.split('\n').filter(l => l.trim()).slice(-5).join('\n');
                            errors.push({
                                file: mainTex,
                                line: 0,
                                message: lastLines,
                            });
                        } else {
                            errors.push({
                                file: mainTex,
                                line: 0,
                                message: `Compiler exited with code ${code}`,
                            });
                        }
                    }

                    // Update VS Code diagnostics
                    this.updateDiagnostics(actuallySucceeded ? [] : errors, workspaceFolder);

                    resolve({
                        success: actuallySucceeded,
                        pdfPath: pdfExists ? pdfPath : undefined,
                        errors: actuallySucceeded ? [] : errors,
                        warnings,
                        duration,
                    });
                });
            });

            proc.on('error', (err) => {
                this.currentProcess = undefined;
                resolve({
                    success: false,
                    errors: [{ file: mainTex, line: 0, message: `Failed to start compiler: ${err.message}` }],
                    warnings: [],
                    duration: Date.now() - startTime,
                });
            });
        });
    }

    /**
     * Cancel current compilation
     */
    cancel(): void {
        if (this.currentProcess) {
            this.currentProcess.kill();
            this.currentProcess = undefined;
        }
    }

    /**
     * Check if currently compiling
     */
    get isCompiling(): boolean {
        return this.currentProcess !== undefined;
    }

    private buildArgs(compiler: CompilerType, mainTex: string, buildDir: string): string[] {
        const common = ['-interaction=nonstopmode', '-synctex=1', '-file-line-error'];

        if (compiler === 'latexmk') {
            return [
                '-pdf',
                ...common,
                `-outdir=${buildDir}`,
                mainTex,
            ];
        }

        return [
            ...common,
            `-output-directory=${buildDir}`,
            mainTex,
        ];
    }

    private async parseLogFile(logPath: string, workspaceFolder: string): Promise<{ errors: CompilationError[]; warnings: string[] }> {
        const errors: CompilationError[] = [];
        const warnings: string[] = [];

        try {
            const logUri = vscode.Uri.file(logPath);
            const logContent = new TextDecoder().decode(await vscode.workspace.fs.readFile(logUri));
            const lines = logContent.split('\n');

            let currentFile = '';

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];

                // Track current file from ( ) nesting — simplified: look for "(./filename"
                const fileMatch = line.match(/\(\.\/([^\s()]+)/);
                if (fileMatch) {
                    currentFile = fileMatch[1];
                }

                // Match -file-line-error format: ./file.tex:123: error message
                const fileLineMatch = line.match(/^\.\/(.+?):(\d+):\s*(.+)/);
                if (fileLineMatch) {
                    const [, file, lineStr, message] = fileLineMatch;
                    if (message.toLowerCase().startsWith('warning')) {
                        warnings.push(`${file}:${lineStr}: ${message}`);
                    } else {
                        errors.push({
                            file: path.isAbsolute(file) ? path.relative(workspaceFolder, file) : file,
                            line: parseInt(lineStr, 10),
                            message: message.trim(),
                        });
                    }
                    continue;
                }

                // Match standard TeX error: "! <error message>"
                const texErrorMatch = line.match(/^!\s+(.+)/);
                if (texErrorMatch) {
                    const message = texErrorMatch[1];
                    // Look ahead for "l.<number>" line indicator
                    let errorLine = 0;
                    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
                        const lineMatch = lines[j].match(/^l\.(\d+)/);
                        if (lineMatch) {
                            errorLine = parseInt(lineMatch[1], 10);
                            break;
                        }
                    }
                    errors.push({
                        file: currentFile || 'unknown',
                        line: errorLine,
                        message: message.trim(),
                    });
                    continue;
                }

                // Match LaTeX/Package Warning patterns
                const warningMatch = line.match(/^(?:LaTeX|Package \w+) Warning:\s*(.+)/);
                if (warningMatch) {
                    warnings.push(warningMatch[1]);
                }

                // Match Overfull/Underfull box warnings
                const boxMatch = line.match(/^((?:Over|Under)full \\[hv]box .+)/);
                if (boxMatch) {
                    warnings.push(boxMatch[1]);
                }
            }
        } catch {
            // Log file may not exist
        }

        return { errors, warnings };
    }

    private updateDiagnostics(errors: CompilationError[], workspaceFolder: string): void {
        this.diagnosticCollection.clear();

        const diagnosticMap = new Map<string, vscode.Diagnostic[]>();

        for (const error of errors) {
            const filePath = path.isAbsolute(error.file)
                ? error.file
                : path.join(workspaceFolder, error.file);
            const uri = vscode.Uri.file(filePath).toString();

            if (!diagnosticMap.has(uri)) {
                diagnosticMap.set(uri, []);
            }

            const line = Math.max(0, error.line - 1);
            const range = new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER);
            const diagnostic = new vscode.Diagnostic(range, error.message, vscode.DiagnosticSeverity.Error);
            diagnostic.source = 'LocalLeaf LaTeX';
            diagnosticMap.get(uri)!.push(diagnostic);
        }

        for (const [uri, diagnostics] of diagnosticMap) {
            this.diagnosticCollection.set(vscode.Uri.parse(uri), diagnostics);
        }
    }

    dispose(): void {
        this.cancel();
        this.diagnosticCollection.dispose();
    }
}
