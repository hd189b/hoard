// File-name helpers: conflict copy names, "(n)" de-duplication, and names
// that are safe on Windows and Android as well as Linux.

/** Key used to detect clashes on case-insensitive file systems (Windows, Android). */
export const clashKey = (p: string) => p.normalize("NFC").toLowerCase();

export function splitPath(p: string): { dir: string; stem: string; ext: string } {
  const slash = p.lastIndexOf("/");
  const dir = slash >= 0 ? p.slice(0, slash + 1) : "";
  const base = p.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return { dir, stem: base, ext: "" };
  return { dir, stem: base.slice(0, dot), ext: base.slice(dot) };
}

/**
 * Return `p`, or `p` with " (1)", " (2)", … added before the extension,
 * whichever is not taken. `taken` holds clashKey() values.
 */
export function uniqueName(p: string, taken: Set<string>): string {
  if (!taken.has(clashKey(p))) return p;
  const { dir, stem, ext } = splitPath(p);
  const m = stem.match(/^(.*) \((\d+)\)$/);
  const root = m ? m[1] : stem;
  for (let n = m ? Number(m[2]) + 1 : 1; ; n++) {
    const cand = `${dir}${root} (${n})${ext}`;
    if (!taken.has(clashKey(cand))) return cand;
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

export function conflictName(p: string, device: string, when: Date): string {
  const { dir, stem, ext } = splitPath(p);
  const d = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}${pad(when.getMinutes())}`;
  const dev = safeSegment(device.trim() || "device").replace(/[()]/g, "");
  return `${dir}${stem} (conflict ${d} ${dev})${ext}`;
}

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** Make one path segment valid on Windows/Android. */
export function safeSegment(seg: string): string {
  let s = seg.replace(/[\\:*?"<>|\u0000-\u001f]/g, "_");
  s = s.replace(/[. ]+$/, (m) => "_".repeat(m.length));
  if (RESERVED.test(s)) s = "_" + s;
  return s || "_";
}

export function safePath(p: string): string {
  return p.split("/").map(safeSegment).join("/");
}

export const isSafePath = (p: string) => safePath(p) === p;
