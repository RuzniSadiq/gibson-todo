// Terminal presentation. The owner is not assumed to be a developer: every
// line printed here should make sense without reading code (Ask Contract).
import { createInterface } from 'node:readline/promises';

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (open, close) => (s) => (tty ? `\u001b[${open}m${s}\u001b[${close}m` : String(s));
export const c = {
  bold: paint(1, 22), dim: paint(2, 22), red: paint(31, 39), green: paint(32, 39),
  yellow: paint(33, 39), blue: paint(34, 39), magenta: paint(35, 39), cyan: paint(36, 39),
  inverse: paint(7, 27),
};

const STAGE_COLOR = {
  PLAN: c.magenta, DECOMPOSE: c.magenta, CLAIM: c.blue, BUILD: c.cyan, GATE: c.cyan,
  REVIEW: c.yellow, 'UX-EVAL': c.yellow, SECURITY: c.red, MERGE: c.green,
  DEPLOY: c.green, RETRO: c.blue, GATE_HUMAN: c.red,
};

export const isInteractive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

export function stage(name, message) {
  const color = STAGE_COLOR[name] ?? c.bold;
  console.log(`${color(c.bold(`[${name.padEnd(9)}]`))} ${message}`);
}
export const info = (m) => console.log(`            ${c.dim(m)}`);
export const ok = (m) => console.log(`            ${c.green('✔')} ${m}`);
export const warn = (m) => console.log(`            ${c.yellow('▲')} ${m}`);
export const fail = (m) => console.log(`            ${c.red('✖')} ${m}`);

export function banner(title, subtitle) {
  const line = '─'.repeat(Math.max(title.length, subtitle?.length ?? 0) + 4);
  console.log(`\n${c.bold(line)}\n  ${c.bold(title)}${subtitle ? `\n  ${c.dim(subtitle)}` : ''}\n${c.bold(line)}`);
}

/** Prints a boxed panel of pre-wrapped lines. */
export function panel(title, lines) {
  console.log(`\n  ${c.bold(c.inverse(` ${title} `))}`);
  for (const l of lines) console.log(`  ${c.dim('│')} ${l}`);
  console.log('');
}

/** The Ask Contract: what / what it does / why / risks — always all four. */
export function askContract({ title, asking, does, why, risks }) {
  panel(title, [
    `${c.bold('What I\'m asking:')} ${asking}`,
    `${c.bold('What it does:')}    ${does}`,
    `${c.bold('Why:')}             ${why}`,
    `${c.bold('Risks:')}           ${risks}`,
  ]);
}

export async function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`  ${c.bold('›')} ${question} `)).trim();
  } finally {
    rl.close();
  }
}

/** A spinner with elapsed time for long agent runs. Returns stop(). */
export function spinner(label) {
  if (!process.stdout.isTTY) {
    console.log(`            ${c.dim('…')} ${label}`);
    return () => {};
  }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const started = Date.now();
  let i = 0;
  const timer = setInterval(() => {
    const s = Math.round((Date.now() - started) / 1000);
    const elapsed = s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
    process.stdout.write(`\r            ${c.cyan(frames[i++ % frames.length])} ${label} ${c.dim(elapsed)}   `);
  }, 100);
  return () => {
    clearInterval(timer);
    process.stdout.write('\r\u001b[2K');
  };
}

export const wrap = (text, width = 76) =>
  String(text).split('\n').flatMap((para) => {
    const out = [];
    let line = '';
    for (const word of para.split(/\s+/)) {
      if ((line + ' ' + word).trim().length > width) { out.push(line); line = word; } else line = `${line} ${word}`.trim();
    }
    out.push(line);
    return out;
  });
