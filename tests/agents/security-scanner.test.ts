import { describe, it, expect, beforeEach } from 'vitest';
import {
    scanContent,
    scanForVulnerabilities,
    createSessionScanner,
    SessionScanner,
} from '../../src/agents/security-scanner';

describe('security-scanner', () => {
    // ── Individual pattern detection ────────────────

    it('detects child_process.exec', () => {
        const code = `const cp = require('child_process').exec('ls');`;
        const findings = scanContent(code, 'test.ts');
        expect(findings).toHaveLength(1);
        expect(findings[0].pattern).toBe('child_process.exec');
        expect(findings[0].severity).toBe('high');
    });

    it('detects eval()', () => {
        const code = `const result = eval('1 + 2');`;
        const findings = scanContent(code, 'test.ts');
        expect(findings).toHaveLength(1);
        expect(findings[0].pattern).toBe('eval()');
    });

    it('detects new Function()', () => {
        const code = `const fn = new Function('a', 'return a');`;
        const findings = scanContent(code, 'test.ts');
        expect(findings).toHaveLength(1);
        expect(findings[0].pattern).toBe('new Function()');
        expect(findings[0].severity).toBe('medium');
    });

    it('detects dangerouslySetInnerHTML', () => {
        const code = `<div dangerouslySetInnerHTML={{ __html: data }} />`;
        const findings = scanContent(code, 'test.tsx');
        expect(findings).toHaveLength(1);
        expect(findings[0].pattern).toBe('dangerouslySetInnerHTML');
    });

    it('detects innerHTML assignment', () => {
        const code = `element.innerHTML = userInput;`;
        const findings = scanContent(code, 'test.ts');
        expect(findings).toHaveLength(1);
        expect(findings[0].pattern).toBe('innerHTML assignment');
    });

    it('detects pickle.load', () => {
        const code = `data = pickle.load(open('data.pkl', 'rb'))`;
        const findings = scanContent(code, 'test.py');
        expect(findings).toHaveLength(1);
        expect(findings[0].pattern).toBe('pickle.load/loads');
        expect(findings[0].severity).toBe('critical');
    });

    it('detects pickle.loads', () => {
        const code = `data = pickle.loads(raw_bytes)`;
        const findings = scanContent(code, 'test.py');
        expect(findings).toHaveLength(1);
        expect(findings[0].pattern).toBe('pickle.load/loads');
    });

    it('detects os.system()', () => {
        const code = `os.system('rm -rf /')`;
        const findings = scanContent(code, 'test.py');
        expect(findings).toHaveLength(1);
        expect(findings[0].pattern).toBe('os.system()');
    });

    it('detects GitHub Actions injection', () => {
        const code = `run: echo \${{ github.event.issue.title }}`;
        const findings = scanContent(code, '.github/workflows/ci.yml');
        expect(findings).toHaveLength(1);
        expect(findings[0].pattern).toBe('GitHub Actions injection');
    });

    // ── Clean code ──────────────────────────────────

    it('produces no findings for clean code', () => {
        const code = [
            'import * as fs from "fs";',
            'const data = JSON.parse(content);',
            'element.textContent = userInput;',
            'subprocess.run(["ls"], shell=False)',
        ].join('\n');
        const findings = scanContent(code, 'clean.ts');
        expect(findings).toHaveLength(0);
    });

    // ── Line number detection ───────────────────────

    it('reports correct line numbers', () => {
        const code = [
            '// line 1',
            '// line 2',
            'const x = eval("bad");',
            '// line 4',
        ].join('\n');
        const findings = scanContent(code, 'test.ts');
        expect(findings).toHaveLength(1);
        expect(findings[0].line).toBe(3);
    });

    // ── Multi-file scan ─────────────────────────────

    it('scans multiple files', () => {
        const files = new Map<string, string>([
            ['a.ts', 'const x = eval("1");'],
            ['b.py', 'pickle.load(f)'],
        ]);
        const result = scanForVulnerabilities(files);
        expect(result.scannedFiles).toBe(2);
        expect(result.findings).toHaveLength(2);
    });

    it('sets blocked=true when critical finding present', () => {
        const files = new Map<string, string>([
            ['a.py', 'pickle.load(f)'],
        ]);
        const result = scanForVulnerabilities(files);
        expect(result.blocked).toBe(true);
    });

    it('sets blocked=false when no critical findings', () => {
        const files = new Map<string, string>([
            ['a.ts', 'const x = eval("1");'],
        ]);
        const result = scanForVulnerabilities(files);
        expect(result.blocked).toBe(false);
    });

    // ── Session-scoped dedup ────────────────────────

    describe('SessionScanner', () => {
        let scanner: SessionScanner;

        beforeEach(() => {
            scanner = createSessionScanner();
        });

        it('returns findings on first occurrence', () => {
            const findings = scanner.scan('eval("x")', 'a.ts');
            expect(findings).toHaveLength(1);
        });

        it('suppresses duplicate pattern warnings', () => {
            scanner.scan('eval("x")', 'a.ts');
            const second = scanner.scan('eval("y")', 'b.ts');
            expect(second).toHaveLength(0);
        });

        it('allows different patterns through', () => {
            scanner.scan('eval("x")', 'a.ts');
            const findings = scanner.scan('element.innerHTML = x;', 'b.ts');
            expect(findings).toHaveLength(1);
            expect(findings[0].pattern).toBe('innerHTML assignment');
        });

        it('reset() clears warned set', () => {
            scanner.scan('eval("x")', 'a.ts');
            scanner.reset();
            const findings = scanner.scan('eval("y")', 'b.ts');
            expect(findings).toHaveLength(1);
        });
    });
});
