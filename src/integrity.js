// ─────────────────────────────────────────────────────────────────────────────
// integrity.js — zero-miss commit-integrity comparison (pure logic; IO injected).
//
// A count match alone is NOT sufficient (two histories can share a count), so we
// compare THREE things between the migrated side (A, our staging/mirror) and the
// destination (B, the target remote):
//   1. the full ref set (every branch + tag), both directions;
//   2. each shared ref's tip OID;
//   3. the total commit count (git rev-list --count --all).
//
// For rewrite modes the comparison is against the POST-REWRITE staging mirror, so
// OIDs legitimately differ from the original source — that is expected and fine.
// ─────────────────────────────────────────────────────────────────────────────

/** Normalize a ref map (object or Map of name→oid) to a plain object with trimmed values. */
function asMap(refs) {
  const out = {};
  if (!refs) return out;
  const entries = refs instanceof Map ? [...refs.entries()] : Object.entries(refs);
  for (const [k, v] of entries) {
    const name = String(k).trim();
    if (name) out[name] = String(v ?? '').trim();
  }
  return out;
}

/**
 * Compare two ref maps. Returns the refs present only on one side and the shared
 * refs whose tip OIDs disagree.
 * @returns {{missing:string[], extra:string[], mismatched:Array<{ref,a,b}>, refSetOk:boolean}}
 */
export function diffRefs(aRefs, bRefs) {
  const a = asMap(aRefs);
  const b = asMap(bRefs);
  const missing = []; // on A (source of truth) but not on B (target)
  const extra = [];   // on B but not on A
  const mismatched = [];
  for (const ref of Object.keys(a)) {
    if (!(ref in b)) missing.push(ref);
    else if (a[ref] !== b[ref]) mismatched.push({ ref, a: a[ref], b: b[ref] });
  }
  for (const ref of Object.keys(b)) if (!(ref in a)) extra.push(ref);
  missing.sort();
  extra.sort();
  mismatched.sort((x, y) => (x.ref < y.ref ? -1 : x.ref > y.ref ? 1 : 0));
  return { missing, extra, mismatched, refSetOk: missing.length === 0 && extra.length === 0 };
}

/**
 * Full integrity verdict between the migrated side A and the destination B.
 *   ok ⇔ every A ref exists on B with the same tip OID AND commit counts match.
 * Target-only refs (`extra`, e.g. a destination's pre-existing default branch) are
 * reported but do NOT by themselves fail the check, since they cannot drop any of
 * our migrated commits.
 * @param {object} p
 * @param {object|Map} p.aRefs  migrated side ref→oid (staging mirror after rewrite, or the source mirror for Mode B)
 * @param {object|Map} p.bRefs  destination ref→oid
 * @param {number} p.aCount     `git rev-list --count --all` on A
 * @param {number} p.bCount     `git rev-list --count --all` on B
 * @param {string} [p.aLabel]   label for A in the report
 * @param {string} [p.bLabel]   label for B in the report
 */
export function compareIntegrity({ aRefs, bRefs, aCount, bCount, aLabel = 'migrated', bLabel = 'destination' } = {}) {
  const refs = diffRefs(aRefs, bRefs);
  const countOk = Number(aCount) === Number(bCount);
  const ok = refs.missing.length === 0 && refs.mismatched.length === 0 && countOk;
  return {
    ok,
    countOk,
    aCount: Number(aCount),
    bCount: Number(bCount),
    aLabel,
    bLabel,
    missing: refs.missing,
    extra: refs.extra,
    mismatched: refs.mismatched,
    refSetOk: refs.refSetOk,
  };
}

/** Render a precise, human-readable integrity report (used on both pass and fail). */
export function formatIntegrityReport(r) {
  if (!r) return 'No integrity result.';
  const lines = [];
  if (r.ok) {
    lines.push(`Integrity OK — ${r.aLabel} and ${r.bLabel} match: ` +
      `${r.aCount} commits, every ref tip identical${r.extra.length ? ` (+${r.extra.length} pre-existing ref(s) on ${r.bLabel}, kept)` : ''}.`);
    return lines.join('\n');
  }
  lines.push(`Integrity MISMATCH between ${r.aLabel} and ${r.bLabel}:`);
  if (!r.countOk) lines.push(`  • commit count differs: ${r.aLabel}=${r.aCount} vs ${r.bLabel}=${r.bCount} (Δ ${r.aCount - r.bCount})`);
  if (r.missing.length) lines.push(`  • ${r.missing.length} ref(s) missing on ${r.bLabel}: ${r.missing.join(', ')}`);
  for (const m of r.mismatched) lines.push(`  • ref tip differs: ${m.ref} — ${r.aLabel} ${m.a} vs ${r.bLabel} ${m.b}`);
  if (r.extra.length) lines.push(`  • (info) ${r.extra.length} ref(s) only on ${r.bLabel}: ${r.extra.join(', ')}`);
  return lines.join('\n');
}
