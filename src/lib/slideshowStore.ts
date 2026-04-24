import 'server-only';
import { randomBytes } from 'node:crypto';
import type { Statement } from 'better-sqlite3';
import { getDb } from './db';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function newSlug(): string {
  const buf = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += ALPHABET[buf[i] % 62];
  return out;
}

export type SlideshowRow = {
  slug: string;
  ids: string[];
  title: string | null;
  image_count: number;
  created_at: number;
  view_count: number;
};

type Stmts = {
  insert: Statement;
  selectBySlug: Statement;
  bumpView: Statement;
};

let stmts: Stmts | null = null;

function getStmts(): Stmts {
  if (stmts) return stmts;
  const db = getDb();
  stmts = {
    insert: db.prepare(`
      INSERT INTO slideshows (slug, ids, title, image_count, creator_ip, created_at)
      VALUES (@slug, @ids, @title, @image_count, @creator_ip, @created_at)
    `),
    selectBySlug: db.prepare(
      `SELECT slug, ids, title, image_count, created_at, view_count
       FROM slideshows WHERE slug = ?`,
    ),
    bumpView: db.prepare(
      `UPDATE slideshows SET view_count = view_count + 1 WHERE slug = ?`,
    ),
  };
  return stmts;
}

type Row = {
  slug: string;
  ids: string;
  title: string | null;
  image_count: number;
  created_at: number;
  view_count: number;
};

export function createSlideshow(args: {
  ids: string[];
  title: string | null;
  creatorIp: string;
}): string {
  const { insert } = getStmts();
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify(args.ids);

  // Collisions are astronomically unlikely at 8×62 bits, but catch the
  // UNIQUE violation and retry a few times anyway.
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = newSlug();
    try {
      insert.run({
        slug,
        ids: payload,
        title: args.title,
        image_count: args.ids.length,
        creator_ip: args.creatorIp,
        created_at: now,
      });
      return slug;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('UNIQUE')) throw e;
    }
  }
  throw new Error('slideshow slug allocation failed');
}

export function getSlideshow(slug: string): SlideshowRow | null {
  const { selectBySlug } = getStmts();
  const row = selectBySlug.get(slug) as Row | undefined;
  if (!row) return null;
  let ids: string[] = [];
  try {
    const parsed = JSON.parse(row.ids);
    if (Array.isArray(parsed)) ids = parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    ids = [];
  }
  return {
    slug: row.slug,
    ids,
    title: row.title,
    image_count: row.image_count,
    created_at: row.created_at,
    view_count: row.view_count,
  };
}

export function bumpSlideshowView(slug: string): void {
  try {
    getStmts().bumpView.run(slug);
  } catch {
    // non-fatal — view counter is best-effort
  }
}
