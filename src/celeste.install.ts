// Acceptance check for the player's own copy of Celeste.
//
// Nothing about the game ships with this package: the host hands over an
// installation the player already owns, and the runtime patches it in the
// browser. That patching pass costs a couple of minutes and ~600 MB of memory,
// so it is worth knowing *before* it starts that what arrived is actually a
// Celeste install and not, say, the Steam depot manifest or an archive with the
// wrong folder nested inside it.
//
// The check is structural, over a file listing — no hashes. Celeste has shipped
// in enough builds (Steam/itch/Epic, FNA and XNA, 1.4.0.0 and the older
// releases, plus whatever a previous Everest install left behind) that a
// fingerprint would reject far more legitimate copies than broken ones. Every
// path below is one the game or Everest actually reads:
//
//   Content/Dialog/english.txt          Dialog, loaded at boot
//   Content/Maps                        the chapter .bin files
//   Content/Graphics                    the atlases
//   Content/FMOD/Desktop/Master Bank.bank   Audio.Banks.Load("Master Bank")
//
// Matching is case-insensitive, and that is not defensive programming — it is
// load-bearing. Celeste's own Content/ is inconsistently cased: `english.txt`
// is lowercase while `French.txt` and `German.txt` next to it are not. A
// case-sensitive check rejects every genuine install, and does it only in the
// browser, because OPFS is case-sensitive while the macOS and Windows
// filesystems the install was read from are not.

/** The executables a Celeste install can present, newest first. */
export const EXECUTABLES = ['Celeste.dll', 'Celeste.exe'] as const;

/** Paths that must be present, relative to the install root. Matched case-insensitively. */
export const REQUIRED_ENTRIES: readonly string[] = [
  'Content/Dialog/english.txt',
  'Content/Maps',
  'Content/Graphics',
  'Content/FMOD/Desktop/Master Bank.bank',
];

/**
 * Assemblies that identify the XNA-alike a build was linked against.
 *
 * `BuildIsFNA.txt` / `BuildIsXNA.txt` are the markers Everest's updater reads,
 * but *Everest writes them* — a vanilla install has neither, so the flavour has
 * to be recoverable from the install itself.
 */
const FLAVOR_ASSEMBLIES: ReadonlyArray<[string, InstallFlavor]> = [
  ['fna.dll', 'fna'],
  ['microsoft.xna.framework.dll', 'xna'],
];

/** Which XNA-alike the install was built against. */
export type InstallFlavor = 'fna' | 'xna' | 'unknown';

export interface InstallCheck {
  /** True when the runtime has everything it needs to patch and boot. */
  ok: boolean;
  /**
   * Prefix inside the supplied listing where the install actually starts.
   * Empty when it is at the top level, `"Celeste/"` when the player zipped the
   * containing folder.
   */
  root: string;
  /** The executable that was found, without the root prefix. */
  executable: string | null;
  flavor: InstallFlavor;
  /** Required entries that are absent, without the root prefix. */
  missing: string[];
  /** True when a previous Everest install came along with the game. */
  hasEverest: boolean;
  /** Why the check failed, ready to show a player. Empty when `ok`. */
  reason: string;
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * Where the install begins.
 *
 * A player who zips their Celeste folder produces `Celeste/Celeste.exe`; one
 * who zips its *contents* produces `Celeste.exe`. Both are normal, so the root
 * is derived from wherever the executable turned up — the shallowest one, in
 * case a backup copy is nested deeper (Everest's `orig/` keeps one).
 */
function findRoot(paths: string[]): { root: string; executable: string | null } {
  let best: { root: string; executable: string } | null = null;

  for (const path of paths) {
    const lower = path.toLowerCase();
    for (const executable of EXECUTABLES) {
      const name = executable.toLowerCase();
      const at = lower === name ? '' : lower.endsWith(`/${name}`) ? path.slice(0, -name.length) : null;
      if (at === null) continue;
      // `orig/Celeste.exe` is the vanilla backup Everest keeps beside the
      // patched game; the install root is its parent, never that folder.
      if (/(^|\/)orig\/$/i.test(at)) continue;
      const depth = at.split('/').length;
      if (!best || depth < best.root.split('/').length) {
        best = { root: at, executable };
      }
    }
  }

  return best ?? { root: '', executable: null };
}

/**
 * Run the acceptance check over a listing of the supplied install.
 *
 * `paths` are relative paths with either separator; directories may be present
 * as entries in their own right (with or without a trailing slash) or implied
 * by the files inside them, which is what a zip central directory and a
 * recursive directory walk respectively give you.
 */
export function inspectInstall(paths: Iterable<string>): InstallCheck {
  const all = [...paths].map(normalize).filter(Boolean);
  const { root, executable } = findRoot(all);

  // Lowercased, so every lookup below is case-insensitive. `missing` still
  // reports the canonical spelling, which is what a player would go looking for.
  const inside = new Set<string>();
  for (const path of all) {
    if (!path.toLowerCase().startsWith(root.toLowerCase())) continue;
    const relative = path.slice(root.length).replace(/\/+$/, '').toLowerCase();
    if (!relative) continue;
    inside.add(relative);
    // Record every ancestor, so a listing of files alone still satisfies a
    // directory requirement.
    for (let at = relative.lastIndexOf('/'); at > 0; at = relative.lastIndexOf('/', at - 1)) {
      inside.add(relative.slice(0, at));
    }
  }

  const missing = REQUIRED_ENTRIES.filter((entry) => !inside.has(entry.toLowerCase()));
  const flavor: InstallFlavor = inside.has('buildisfna.txt')
    ? 'fna'
    : inside.has('buildisxna.txt')
      ? 'xna'
      : (FLAVOR_ASSEMBLIES.find(([assembly]) => inside.has(assembly))?.[1] ?? 'unknown');
  const hasEverest =
    inside.has('everest/celeste.mod.mm.dll') || inside.has('everest-launch.txt');

  if (!executable) {
    return {
      ok: false,
      root,
      executable: null,
      flavor,
      missing,
      hasEverest,
      reason:
        'No Celeste.exe or Celeste.dll in there. Supply your own Celeste installation — ' +
        'the folder the game runs from, the one with Content/ next to the executable.',
    };
  }

  if (missing.length > 0) {
    return {
      ok: false,
      root,
      executable,
      flavor,
      missing,
      hasEverest,
      reason:
        `That install is missing ${missing.join(', ')}. ` +
        'Celeste and its whole Content/ directory have to come across together; ' +
        'the executable on its own is not enough.',
    };
  }

  return { ok: true, root, executable, flavor, missing, hasEverest, reason: '' };
}

/** `inspectInstall`, phrased as the gate the SDK puts in front of `load()`. */
export function verifyInstall(paths: Iterable<string>): InstallCheck {
  return inspectInstall(paths);
}
