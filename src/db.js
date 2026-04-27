// src/db.js — RunMate Database
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'runmate.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  /* ══ USERS ══ */
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    email         TEXT UNIQUE NOT NULL,
    password      TEXT NOT NULL,
    city          TEXT DEFAULT '',
    lat           REAL DEFAULT 41.1579,
    lng           REAL DEFAULT -8.6291,
    pace          TEXT DEFAULT '',
    distance      TEXT DEFAULT '',
    schedule      TEXT DEFAULT '',
    goal          TEXT DEFAULT '',
    level         TEXT DEFAULT 'iniciante',
    radius_km     INTEGER DEFAULT 15,
    available     INTEGER DEFAULT 1,
    avatar        TEXT DEFAULT '',
    bio           TEXT DEFAULT '',
    km_year       REAL DEFAULT 0,
    races_done    INTEGER DEFAULT 0,
    last_seen     TEXT DEFAULT (datetime('now')),
    created_at    TEXT DEFAULT (datetime('now'))
  );

  /* ══ GPS LOCATIONS (live positions) ══ */
  CREATE TABLE IF NOT EXISTS locations (
    user_id       TEXT PRIMARY KEY REFERENCES users(id),
    lat           REAL NOT NULL,
    lng           REAL NOT NULL,
    accuracy      REAL DEFAULT 0,
    heading       REAL DEFAULT 0,
    speed         REAL DEFAULT 0,
    is_running    INTEGER DEFAULT 0,
    updated_at    TEXT DEFAULT (datetime('now'))
  );

  /* ══ GPS TRACKS (recorded runs) ══ */
  CREATE TABLE IF NOT EXISTS tracks (
    id            TEXT PRIMARY KEY,
    user_id       TEXT REFERENCES users(id),
    partner_id    TEXT REFERENCES users(id),
    started_at    TEXT NOT NULL,
    ended_at      TEXT,
    distance_km   REAL DEFAULT 0,
    duration_sec  INTEGER DEFAULT 0,
    avg_pace      TEXT DEFAULT '',
    polyline      TEXT DEFAULT '',
    created_at    TEXT DEFAULT (datetime('now'))
  );

  /* ══ TRACK POINTS ══ */
  CREATE TABLE IF NOT EXISTS track_points (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id      TEXT REFERENCES tracks(id),
    lat           REAL NOT NULL,
    lng           REAL NOT NULL,
    timestamp     TEXT NOT NULL,
    speed         REAL DEFAULT 0
  );

  /* ══ MESSAGES ══ */
  CREATE TABLE IF NOT EXISTS messages (
    id            TEXT PRIMARY KEY,
    from_user     TEXT REFERENCES users(id),
    to_user       TEXT,
    is_group      INTEGER DEFAULT 0,
    body          TEXT NOT NULL,
    read          INTEGER DEFAULT 0,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  /* ══ RACES ══ */
  CREATE TABLE IF NOT EXISTS races (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    type          TEXT DEFAULT 'road',
    distance_km   REAL,
    distance_label TEXT,
    race_date     TEXT,
    location      TEXT,
    created_by    TEXT REFERENCES users(id),
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS race_participants (
    race_id       TEXT REFERENCES races(id),
    user_id       TEXT REFERENCES users(id),
    joined_at     TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (race_id, user_id)
  );

  /* ══ COACHING PLANS ══ */
  CREATE TABLE IF NOT EXISTS coaching_plans (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    slug          TEXT UNIQUE NOT NULL,
    tagline       TEXT,
    description   TEXT,
    price_month   REAL NOT NULL,
    price_year    REAL,
    color         TEXT DEFAULT '#E8511A',
    features      TEXT
  );

  /* ══ COACHING SUBSCRIPTIONS ══ */
  CREATE TABLE IF NOT EXISTS coaching_subscriptions (
    id            TEXT PRIMARY KEY,
    user_id       TEXT REFERENCES users(id),
    plan_id       TEXT REFERENCES coaching_plans(id),
    billing       TEXT DEFAULT 'monthly',
    status        TEXT DEFAULT 'active',
    started_at    TEXT DEFAULT (datetime('now')),
    renews_at     TEXT,
    cancelled_at  TEXT
  );

  /* ══ COACHING WORKOUTS ══ */
  CREATE TABLE IF NOT EXISTS coaching_workouts (
    id            TEXT PRIMARY KEY,
    sub_id        TEXT REFERENCES coaching_subscriptions(id),
    user_id       TEXT REFERENCES users(id),
    week_num      INTEGER,
    day_of_week   INTEGER,
    title         TEXT,
    type          TEXT,
    description   TEXT,
    distance_km   REAL DEFAULT 0,
    duration_min  INTEGER DEFAULT 0,
    intensity     TEXT DEFAULT 'low',
    completed     INTEGER DEFAULT 0,
    completed_at  TEXT,
    notes_athlete TEXT DEFAULT '',
    scheduled_for TEXT,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  /* ══ COACHING MESSAGES ══ */
  CREATE TABLE IF NOT EXISTS coaching_messages (
    id            TEXT PRIMARY KEY,
    sub_id        TEXT REFERENCES coaching_subscriptions(id),
    from_coach    INTEGER DEFAULT 0,
    body          TEXT NOT NULL,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  /* ══ ATHLETE GOALS ══ */
  CREATE TABLE IF NOT EXISTS athlete_goals (
    id            TEXT PRIMARY KEY,
    user_id       TEXT REFERENCES users(id),
    race_name     TEXT,
    target_time   TEXT,
    race_date     TEXT,
    current_pb    TEXT,
    notes         TEXT,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  /* ══ TRAINING INVITES ══ */
  CREATE TABLE IF NOT EXISTS invites (
    id            TEXT PRIMARY KEY,
    from_user     TEXT REFERENCES users(id),
    to_user       TEXT REFERENCES users(id),
    message       TEXT DEFAULT '',
    status        TEXT DEFAULT 'pending',
    created_at    TEXT DEFAULT (datetime('now'))
  );
`);

// ── SEED COACHING PLANS ──────────────────────────
function seedPlans() {
  const count = db.prepare('SELECT COUNT(*) as n FROM coaching_plans').get().n;
  if (count > 0) return;

  function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }
  const plans = [
    {
      id: uuidv4(), name: 'Plano Essencial', slug: 'essencial',
      tagline: 'Treinos organizados, semana a semana',
      description: 'Para quem quer estruturar os treinos com orientação profissional.',
      price_month: 19.99, price_year: 179.99, color: '#1A6BE8',
      features: JSON.stringify(['Plano semanal personalizado','Treinos: fácil, ritmo e longo','Ajustes mensais','Histórico de treinos','Suporte por mensagem (48h)'])
    },
    {
      id: uuidv4(), name: 'Plano Elite', slug: 'elite',
      tagline: 'Coaching completo orientado a objetivos',
      description: 'Para atletas sérios com metas específicas e acompanhamento intensivo.',
      price_month: 49.99, price_year: 449.99, color: '#E8511A',
      features: JSON.stringify(['Tudo do Essencial','Definição de objetivos e PBs','Análise semanal','Periodização anual','VO2max e intervalos','Suporte diário','Videochamada mensal 30min','Prep. específica para provas'])
    }
  ];
  const insert = db.prepare('INSERT INTO coaching_plans (id,name,slug,tagline,description,price_month,price_year,color,features) VALUES (@id,@name,@slug,@tagline,@description,@price_month,@price_year,@color,@features)');
  plans.forEach(p => insert.run(p));
  console.log('✅ Coaching plans seeded');
}

seedPlans();

module.exports = db;
