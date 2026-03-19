/**
 * GICS CLI UI — Zero-dep ANSI terminal utilities
 */

const isTTY = !!(process.stdout.isTTY && !process.env.NO_COLOR);

const esc = (code: string) => (isTTY ? `\x1b[${code}` : '');

export const c = {
    green: (s: string) => `${esc('32m')}${s}${esc('0m')}`,
    red: (s: string) => `${esc('31m')}${s}${esc('0m')}`,
    yellow: (s: string) => `${esc('33m')}${s}${esc('0m')}`,
    cyan: (s: string) => `${esc('36m')}${s}${esc('0m')}`,
    magenta: (s: string) => `${esc('35m')}${s}${esc('0m')}`,
    bold: (s: string) => `${esc('1m')}${s}${esc('0m')}`,
    dim: (s: string) => `${esc('2m')}${s}${esc('0m')}`,
    bgGreen: (s: string) => `${esc('42m')}${s}${esc('0m')}`,
};

export class Spinner {
    private frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    private idx = 0;
    private timer: ReturnType<typeof setInterval> | null = null;
    private msg = '';

    start(msg: string): void {
        this.msg = msg;
        if (!isTTY) {
            process.stdout.write(`  ${msg}\n`);
            return;
        }
        this.timer = setInterval(() => {
            const frame = this.frames[this.idx % this.frames.length];
            process.stdout.write(`\r${c.cyan(frame!)} ${this.msg}`);
            this.idx++;
        }, 80);
    }

    update(msg: string): void {
        this.msg = msg;
    }

    succeed(msg: string): void {
        this.stop();
        process.stdout.write(`${isTTY ? '\r' : ''}${c.green('✓')} ${msg}\n`);
    }

    fail(msg: string): void {
        this.stop();
        process.stdout.write(`${isTTY ? '\r' : ''}${c.red('✗')} ${msg}\n`);
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (isTTY) process.stdout.write('\r\x1b[K');
    }
}

export function progressBar(current: number, total: number, width = 30): string {
    const pct = total > 0 ? current / total : 0;
    const filled = Math.round(pct * width);
    const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
    return `${bar} ${Math.round(pct * 100)}%`;
}

export function table(headers: string[], rows: string[][]): string {
    const cols = headers.length;
    const widths = headers.map((h, i) => {
        const maxRow = rows.reduce((mx, r) => Math.max(mx, stripAnsi(r[i] ?? '').length), 0);
        return Math.max(stripAnsi(h).length, maxRow);
    });

    const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - stripAnsi(s).length));
    const hLine = (l: string, m: string, r: string, f: string) =>
        l + widths.map(w => f.repeat(w + 2)).join(m) + r;

    const lines: string[] = [];
    lines.push(hLine('╭', '┬', '╮', '─'));
    lines.push('│ ' + headers.map((h, i) => c.bold(pad(h, widths[i]!))).join(' │ ') + ' │');
    lines.push(hLine('├', '┼', '┤', '─'));
    for (const row of rows) {
        lines.push('│ ' + Array.from({ length: cols }, (_, i) => pad(row[i] ?? '', widths[i]!)).join(' │ ') + ' │');
    }
    lines.push(hLine('╰', '┴', '╯', '─'));
    return lines.join('\n');
}

export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function colorRatio(ratio: number): string {
    const str = `${ratio.toFixed(2)}x`;
    if (ratio >= 20) return c.bold(c.green(str));
    if (ratio >= 10) return c.green(str);
    if (ratio >= 5) return c.yellow(str);
    return c.red(str);
}

export function daemonBanner(): string {
    return [
        c.cyan('╔═══════════════════════════╗'),
        c.cyan('║') + c.bold('   GICS Daemon v1.3.3     ') + c.cyan('║'),
        c.cyan('╚═══════════════════════════╝'),
    ].join('\n');
}

function stripAnsi(s: string): string {
    return s.replace(new RegExp('\\\\x1b\\\\[[0-9;]*m', 'g'), '');
}

function mapReplacer(_key: string, value: unknown): unknown {
    if (value instanceof Map) {
        const obj: Record<string, unknown> = {};
        for (const [k, v] of value) obj[String(k)] = v;
        return obj;
    }
    return value;
}

export { mapReplacer };
