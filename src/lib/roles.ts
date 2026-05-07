export type EyeColor = 'black' | 'orange' | 'green' | 'blue' | 'red';

export type Requirement = Partial<Record<EyeColor, number>>;

export type Role = {
  id: string;
  label: string;
  emoji: string[];
  combo: boolean;
  requires: Requirement;
};

export const EYE_COLORS: readonly EyeColor[] = ['black', 'orange', 'green', 'blue', 'red'];

export const COLOR_EMOJI: Record<EyeColor, string> = {
  black: '⚫',
  orange: '🟠',
  green: '🟢',
  blue: '🔵',
  red: '🔴',
};

// Hand-ranked: rarest / hardest first → easiest last.
// Reorder this array to change display priority everywhere.
export const ROLES: Role[] = [
  {
    id: 'top-stack',
    label: '1 Blue + 1 Red + 8 Greens',
    emoji: ['🔵', '🔴', '🟢', '🟢', '🟢', '🟢', '🟢', '🟢', '🟢', '🟢'],
    combo: true,
    requires: { blue: 1, red: 1, green: 8 },
  },
  {
    id: 'rainbow',
    label: '1 Green + 1 Blue + 1 Red',
    emoji: ['🟢', '🔵', '🔴'],
    combo: true,
    requires: { green: 1, blue: 1, red: 1 },
  },
  {
    id: 'rnb',
    label: '1 Blue + 1 Red',
    emoji: ['🔵', '🔴'],
    combo: true,
    requires: { blue: 1, red: 1 },
  },
  { id: 'red-1', label: '1 Red Eye', emoji: ['🔴'], combo: false, requires: { red: 1 } },
  { id: 'blue-1', label: '1 Blue Eye', emoji: ['🔵'], combo: false, requires: { blue: 1 } },
  {
    id: 'green-3',
    label: '3 Green Eyes',
    emoji: ['🟢', '🟢', '🟢'],
    combo: false,
    requires: { green: 3 },
  },
  { id: 'green-1', label: '1 Green Eye', emoji: ['🟢'], combo: false, requires: { green: 1 } },
  {
    id: 'orange-4',
    label: '4 Orange Eyes',
    emoji: ['🟠', '🟠', '🟠', '🟠'],
    combo: false,
    requires: { orange: 4 },
  },
  { id: 'orange-1', label: '1 Orange Eye', emoji: ['🟠'], combo: false, requires: { orange: 1 } },
  {
    id: 'black-6',
    label: '6 Black Eyes',
    emoji: ['⚫', '⚫', '⚫', '⚫', '⚫', '⚫'],
    combo: false,
    requires: { black: 6 },
  },
  { id: 'black-1', label: '1 Black Eye', emoji: ['⚫'], combo: false, requires: { black: 1 } },
];

const ROLE_BY_ID: Map<string, Role> = new Map(ROLES.map((r) => [r.id, r]));

export function getRoleById(id: string): Role | undefined {
  return ROLE_BY_ID.get(id);
}

export function rankOf(id: string): number {
  const idx = ROLES.findIndex((r) => r.id === id);
  return idx < 0 ? Number.MAX_SAFE_INTEGER : idx;
}

export type ColorCounts = Record<EyeColor, number>;

export function emptyCounts(): ColorCounts {
  return { black: 0, orange: 0, green: 0, blue: 0, red: 0 };
}

export function evaluateRoles(counts: ColorCounts): string[] {
  const earned: string[] = [];
  for (const role of ROLES) {
    let ok = true;
    for (const [color, n] of Object.entries(role.requires) as [EyeColor, number][]) {
      if ((counts[color] ?? 0) < n) {
        ok = false;
        break;
      }
    }
    if (ok) earned.push(role.id);
  }
  return earned;
}

export function sortRoleIds(ids: Iterable<string>): string[] {
  return Array.from(ids).sort((a, b) => rankOf(a) - rankOf(b));
}

// For a given role + a holder's current counts, how short are they per color?
// Returns [] if already earned. Used to drive the "ladder" UI.
export function shortfallFor(role: Role, counts: ColorCounts): { color: EyeColor; need: number }[] {
  const out: { color: EyeColor; need: number }[] = [];
  for (const [color, n] of Object.entries(role.requires) as [EyeColor, number][]) {
    const have = counts[color] ?? 0;
    if (have < n) out.push({ color, need: n - have });
  }
  return out;
}
