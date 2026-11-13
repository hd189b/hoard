// Three-way merge of manifests. Pure: no I/O, no crypto.
//
// base   = manifest at the Git merge-base (last shared sync)
// ours   = this device's side
// theirs = the side already on a remote
//
// The result maps each final path to the entry whose content goes there.
// When `src.p !== path` the content must be re-encrypted under the new path
// (paths are bound into encryption).

import type { Entry, Manifest } from "./format";
import { clashKey, conflictName, uniqueName } from "./names";

export interface MergeOptions {
  device: string;
  now: Date;
}

export interface Conflict {
  path: string;
  copy: string;
  kind: "both-edited" | "both-added";
}

export interface MergeResult {
  result: Map<string, Entry>;
  conflicts: Conflict[];
  /** Files moved to a "(n)" name because they clashed by letter case. */
  clashes: { from: string; to: string }[];
}

const same = (a?: Entry, b?: Entry) => (a === undefined ? b === undefined : b !== undefined && a.h === b.h);

/** Paths deleted from base and re-added elsewhere on the same side with identical content. */
export function detectRenames(base: Manifest, side: Manifest): Map<string, string> {
  const removedByHash = new Map<string, string[]>();
  for (const [p, e] of base) if (!side.has(p)) removedByHash.set(e.h, [...(removedByHash.get(e.h) ?? []), p]);
  const addedByHash = new Map<string, string[]>();
  for (const [p, e] of side) if (!base.has(p)) addedByHash.set(e.h, [...(addedByHash.get(e.h) ?? []), p]);
  const out = new Map<string, string>();
  for (const [h, removed] of removedByHash) {
    const added = addedByHash.get(h);
    if (removed.length === 1 && added?.length === 1) out.set(removed[0], added[0]);
  }
  return out;
}

/** If one side renamed P→Q and the other edited P, move that edit to Q. */
function carryEditsAcrossRenames(base0: Manifest, ours0: Manifest, theirs0: Manifest) {
  const renOurs = detectRenames(base0, ours0);
  const renTheirs = detectRenames(base0, theirs0);
  const base = new Map(base0);
  const ours = new Map(ours0);
  const theirs = new Map(theirs0);
  const carry = (renames: Map<string, string>, otherRenames: Map<string, string>, editor: Manifest) => {
    for (const [from, to] of renames) {
      const edited = editor.get(from);
      const orig = base0.get(from)!;
      if (!edited || edited.h === orig.h || editor.has(to) || otherRenames.has(from)) continue;
      editor.delete(from);
      editor.set(to, edited);
      base.delete(from);
      base.set(to, orig);
    }
  };
  carry(renOurs, renTheirs, theirs);
  carry(renTheirs, renOurs, ours);
  return { base, ours, theirs };
}

export function merge3(base0: Manifest, ours0: Manifest, theirs0: Manifest, opts: MergeOptions): MergeResult {
  const { base, ours, theirs } = carryEditsAcrossRenames(base0, ours0, theirs0);

  const result = new Map<string, Entry>();
  const losers: { path: string; entry: Entry; kind: Conflict["kind"] }[] = [];
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const p of [...paths].sort()) {
    const b = base.get(p);
    const o = ours.get(p);
    const t = theirs.get(p);
    let pick: Entry | undefined;
    if (same(o, t)) pick = t;
    else if (same(o, b)) pick = t; // only theirs changed
    else if (same(t, b)) pick = o; // only ours changed
    else if (!o) pick = t; // ours deleted, theirs edited -> keep edit
    else if (!t) pick = o; // theirs deleted, ours edited -> keep edit
    else {
      // Changed on both sides: the version already on the remote keeps the name.
      pick = t;
      losers.push({ path: p, entry: o, kind: b ? "both-edited" : "both-added" });
    }
    if (pick) result.set(p, pick);
  }

  const taken = new Set([...result.keys()].map(clashKey));
  const conflicts: Conflict[] = [];
  for (const l of losers) {
    const copy = uniqueName(conflictName(l.path, opts.device, opts.now), taken);
    taken.add(clashKey(copy));
    result.set(copy, l.entry);
    conflicts.push({ path: l.path, copy, kind: l.kind });
  }

  const clashes = resolveCaseClashes(result, theirs);
  return { result, conflicts, clashes };
}

/**
 * Two paths that differ only by letter case can't both exist on Windows or
 * Android. Keep the one already on the remote; rename the others to "(n)".
 */
export function resolveCaseClashes(result: Map<string, Entry>, theirs: Manifest): { from: string; to: string }[] {
  const groups = new Map<string, string[]>();
  for (const p of result.keys()) groups.set(clashKey(p), [...(groups.get(clashKey(p)) ?? []), p]);
  const taken = new Set(groups.keys());
  const moved: { from: string; to: string }[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort();
    const keeper = group.find((p) => theirs.has(p)) ?? group[0];
    for (const p of group) {
      if (p === keeper) continue;
      const to = uniqueName(p, taken);
      taken.add(clashKey(to));
      result.set(to, result.get(p)!);
      result.delete(p);
      moved.push({ from: p, to });
    }
  }
  return moved;
}
