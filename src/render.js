// Shared terminal rendering for doctor / status reports.
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = { green: paint(32), yellow: paint(33), red: paint(31), blue: paint(34), dim: paint(2), bold: paint(1) };
const MARK = { pass: c.green('✓'), warn: c.yellow('!'), fail: c.red('✗'), info: c.blue('·') };

export function summarize(sections) {
  const all = sections.flatMap((s) => s.checks);
  const count = (s) => all.filter((x) => x.status === s).length;
  const summary = { pass: count('pass'), warn: count('warn'), fail: count('fail') };
  return { summary, ok: summary.fail === 0 };
}

export function renderReport(title, report, { verbose = false, failLine = 'Fix these before uploading.' } = {}) {
  const lines = [title, ''];
  for (const s of report.sections) {
    lines.push(`${c.bold(s.name)}${s.detail ? '  ' + c.dim(s.detail) : ''}`);
    for (const chk of s.checks) {
      if (chk.status === 'pass' && !verbose && chk.id === 'expected.ok') continue;
      lines.push(`  ${MARK[chk.status]} ${chk.message}`);
      if (chk.hint && chk.status !== 'pass') lines.push(`    ${c.dim('↳ ' + chk.hint)}`);
    }
    const ok = s.checks.filter((x) => x.id === 'expected.ok').length;
    if (ok && !verbose) lines.push(`  ${MARK.pass} ${ok} expected entitlement${ok === 1 ? '' : 's'} present`);
    lines.push('');
  }
  const { pass, warn, fail } = report.summary;
  const tally = `${pass} passed, ${warn} warning${warn === 1 ? '' : 's'}, ${fail} failed`;
  lines.push(fail ? c.red(`✗ ${tally}. ${failLine}`) : c.green(`✓ ${tally}.`));
  return lines.join('\n');
}
