// ─────────────────────────────────────────────────────────────────────────────
// ui.js — premium terminal UX via chalk + ora, with zero-dependency fallbacks so
// the CLI still runs (and --check/--help still work) if the libs aren't present.
// ─────────────────────────────────────────────────────────────────────────────

// chalk (optional) — fall back to a chainable no-color proxy.
let chalk;
try {
  ({ default: chalk } = await import('chalk'));
} catch {
  const handler = {
    get: () => new Proxy((...a) => a.join(' '), handler),
    apply: (_t, _this, a) => a.join(' '),
  };
  chalk = new Proxy((...a) => a.join(' '), handler);
}

// ora (optional) — fall back to a quiet spinner that prints plain status lines.
let oraFactory;
try {
  ({ default: oraFactory } = await import('ora'));
} catch {
  oraFactory = (opts) => {
    const sp = {
      text: typeof opts === 'string' ? opts : opts?.text || '',
      start(t) { if (t) this.text = t; process.stderr.write(`… ${this.text}\n`); return this; },
      succeed(t) { process.stderr.write(`✓ ${t || this.text}\n`); return this; },
      fail(t) { process.stderr.write(`✗ ${t || this.text}\n`); return this; },
      warn(t) { process.stderr.write(`⚠ ${t || this.text}\n`); return this; },
      info(t) { process.stderr.write(`ℹ ${t || this.text}\n`); return this; },
      stop() { return this; },
    };
    return sp;
  };
}

export const c = chalk;
export const spinner = (text) => oraFactory({ text });

export const ui = {
  banner: (m) => console.log(c.bold.cyan(m)),
  step: (m) => console.log('\n' + c.bold.cyan(`==> ${m}`)),
  info: (m) => console.log(m),
  ok: (m) => console.log(c.green(m)),
  warn: (m) => console.log(c.yellow(m)),
  err: (m) => console.error(c.red(m)),
  dim: (m) => console.log(c.dim(m)),
  spinner,
};

export const log = ui;
