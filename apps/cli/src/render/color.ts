const enabled =
  Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";

const wrap = (code: string) => (s: string) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);

export const dim = wrap("2");
export const bold = wrap("1");
export const red = wrap("31");
export const green = wrap("32");
export const yellow = wrap("33");
export const blue = wrap("34");
export const cyan = wrap("36");

const ANSI = /\x1b\[[0-9;]*m/g;

/** Length as the terminal sees it, ignoring colour escapes. */
export const visibleLength = (s: string) => s.replace(ANSI, "").length;

/** Pad to a visible width, so coloured columns still line up. */
export function pad(s: string, width: number): string {
  const gap = width - visibleLength(s);
  return gap > 0 ? s + " ".repeat(gap) : s;
}

export function padStart(s: string, width: number): string {
  const gap = width - visibleLength(s);
  return gap > 0 ? " ".repeat(gap) + s : s;
}
