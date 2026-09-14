import Database from "better-sqlite3";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','reviewer')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pigeons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ring_no TEXT NOT NULL UNIQUE,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  color TEXT NOT NULL DEFAULT '',
  loft TEXT NOT NULL DEFAULT '',
  frozen INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pigeon_id INTEGER NOT NULL REFERENCES pigeons(id),
  from_owner_id INTEGER NOT NULL REFERENCES users(id),
  to_owner_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS races (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  distance_km REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  published_at TEXT,
  appeal_deadline TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id INTEGER NOT NULL REFERENCES races(id),
  pigeon_id INTEGER NOT NULL REFERENCES pigeons(id),
  owner_id INTEGER NOT NULL REFERENCES users(id),
  score REAL NOT NULL,
  rank INTEGER,
  original_rank INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (race_id, pigeon_id)
);

CREATE TABLE IF NOT EXISTS appeals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  result_id INTEGER NOT NULL UNIQUE REFERENCES results(id),
  race_id INTEGER NOT NULL REFERENCES races(id),
  pigeon_id INTEGER NOT NULL REFERENCES pigeons(id),
  owner_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','ACCEPTED','SUPPLEMENT_REQUIRED','REJECTED','REJUDGED')),
  version INTEGER NOT NULL DEFAULT 1,
  supplement_deadline TEXT,
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS appeal_evidences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appeal_id INTEGER NOT NULL REFERENCES appeals(id),
  owner_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'initial' CHECK (kind IN ('initial','supplement')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS appeal_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appeal_id INTEGER NOT NULL REFERENCES appeals(id),
  actor_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ranking_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id INTEGER NOT NULL REFERENCES races(id),
  appeal_id INTEGER REFERENCES appeals(id),
  pigeon_id INTEGER NOT NULL REFERENCES pigeons(id),
  old_score REAL,
  new_score REAL,
  old_rank INTEGER,
  new_rank INTEGER,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_appeals_status ON appeals(status);
CREATE INDEX IF NOT EXISTS idx_appeals_owner ON appeals(owner_id);
CREATE INDEX IF NOT EXISTS idx_appeal_events_appeal ON appeal_events(appeal_id);
CREATE INDEX IF NOT EXISTS idx_results_race ON results(race_id);
CREATE INDEX IF NOT EXISTS idx_results_pigeon ON results(pigeon_id);
CREATE INDEX IF NOT EXISTS idx_ranking_history_race ON ranking_history(race_id);
`;

export function openDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  return db;
}
