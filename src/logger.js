// ─────────────────────────────────────────────────────────────────────────────
// logger.js — leveled logging that is drop-in compatible with the `ui` object the
// pipeline consumes (step/info/ok/warn/err/dim + a chainable spinner()).
//
//   • human mode (default) — delegates to ui.js (chalk + ora).
//   • --json mode          — one JSON object per line on stdout; spinners become
//                            quiet structured events so output stays machine-parseable.
// ─────────────────────────────────────────────────────────────────────────────
import { ui } from './ui.js';

/** A spinner-shaped object that emits structured JSON events instead of animating. */
function jsonSpinner(emit, text) {
  let label = text || '';
  return {
    start(t) { if (t) label = t; emit('progress', label); return this; },
    succeed(t) { emit('ok', t || label); return this; },
    fail(t) { emit('error', t || label); return this; },
    warn(t) { emit('warn', t || label); return this; },
    info(t) { emit('info', t || label); return this; },
    stop() { return this; },
  };
}

/**
 * @param {{json?:boolean, verbose?:boolean}} [opts]
 * @returns a logger exposing banner/step/info/ok/warn/err/dim/spinner + event().
 */
export function createLogger({ json = false, verbose = false } = {}) {
  if (!json) {
    // Human: reuse the rich ui, plus a no-op structured event() and the flags.
    return { ...ui, json: false, verbose, event() {} };
  }
  const emit = (level, msg, extra) =>
    console.log(JSON.stringify({ level, msg: msg == null ? undefined : String(msg), ...(extra || {}) }));
  return {
    json: true,
    verbose,
    banner: (m) => emit('banner', m),
    step: (m) => emit('step', m),
    info: (m) => emit('info', m),
    ok: (m) => emit('ok', m),
    warn: (m) => emit('warn', m),
    err: (m) => emit('error', m),
    dim: (m) => { if (verbose) emit('debug', m); },
    spinner: (text) => jsonSpinner(emit, text),
    /** Structured, machine-readable milestone (ignored in human mode). */
    event: (name, data) => emit('event', name, { event: name, data }),
  };
}
