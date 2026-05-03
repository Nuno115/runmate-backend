// src/db.js — RunMate PostgreSQL Database
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function query(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

async function initDB() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL, city TEXT DEFAULT '', lat REAL DEFAULT 41.1579,
      lng REAL DEFAULT -8.6291, pace TEXT DEFAULT '', distance TEXT DEFAULT '',
      schedule TEXT DEFAULT '', goal TEXT DEFAULT '', level TEXT DEFAULT 'iniciante',
      radius_km INTEGER DEFAULT 15, available INTEGER DEFAULT 1,
      avatar TEXT DEFAULT '', bio TEXT DEFAULT '', km_year REAL DEFAULT 0,
      races_done INTEGER DEFAULT 0, last_seen TIMESTAMP DEFAULT NOW(),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS locations (
      user_id TEXT PRIMARY KEY REFERENCES users(id),
      lat REAL NOT NULL, lng REAL NOT NULL, accuracy REAL DEFAULT 0,
      heading REAL DEFAULT 0, speed REAL DEFAULT 0, is_running INTEGER DEFAULT 0,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, from_user TEXT REFERENCES users(id),
      to_user TEXT, is_group INTEGER DEFAULT 0, body TEXT NOT NULL,
      read INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS tracks (
      id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id),
      partner_id TEXT, started_at TIMESTAMP NOT NULL, ended_at TIMESTAMP,
      distance_km REAL DEFAULT 0, duration_sec INTEGER DEFAULT 0,
      avg_pace TEXT DEFAULT '', created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS races (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT DEFAULT 'road',
      distance_km REAL, distance_label TEXT, race_date TEXT, location TEXT,
      created_by TEXT REFERENCES users(id), created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS race_participants (
      race_id TEXT REFERENCES races(id), user_id TEXT REFERENCES users(id),
      joined_at TIMESTAMP DEFAULT NOW(), PRIMARY KEY (race_id, user_id)
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS coaching_plans (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
      tagline TEXT, description TEXT, price_month REAL NOT NULL,
      price_year REAL, color TEXT DEFAULT '#E8511A', features TEXT
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS coaching_subscriptions (
      id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id),
      plan_id TEXT REFERENCES coaching_plans(id), billing TEXT DEFAULT 'monthly',
      status TEXT DEFAULT 'active', started_at TIMESTAMP DEFAULT NOW(),
      renews_at TIMESTAMP, cancelled_at TIMESTAMP
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS coaching_workouts (
      id TEXT PRIMARY KEY, sub_id TEXT REFERENCES coaching_subscriptions(id),
      user_id TEXT REFERENCES users(id), week_num INTEGER, day_of_week INTEGER,
      title TEXT, type TEXT, description TEXT, distance_km REAL DEFAULT 0,
      duration_min INTEGER DEFAULT 0, intensity TEXT DEFAULT 'low',
      completed INTEGER DEFAULT 0, completed_at TIMESTAMP,
      notes_athlete TEXT DEFAULT '', created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS coaching_messages (
      id TEXT PRIMARY KEY, sub_id TEXT REFERENCES coaching_subscriptions(id),
      from_coach INTEGER DEFAULT 0, body TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS athlete_goals (
      id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id),
      race_name TEXT, target_time TEXT, race_date TEXT,
      current_pb TEXT, notes TEXT, created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS invites (
      id TEXT PRIMARY KEY, from_user TEXT REFERENCES users(id),
      to_user TEXT REFERENCES users(id), message TEXT DEFAULT '',
      status TEXT DEFAULT 'pending', created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS fcm_tokens (
      user_id TEXT PRIMARY KEY REFERENCES users(id),
      token TEXT NOT NULL, updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Seed plans
  const r = await query('SELECT COUNT(*) as count FROM coaching_plans');
  if (parseInt(r.rows[0].count) === 0) {
    const plans = [
      [uuidv4(),'Plano Essencial','essencial','Treinos organizados, semana a semana','',19.99,179.99,'#1A6BE8',JSON.stringify(['Plano semanal personalizado','Treinos: fácil, ritmo e longo','Ajustes mensais','Histórico de treinos','Suporte por mensagem (48h)'])],
      [uuidv4(),'Plano Elite','elite','Coaching completo orientado a objetivos','',49.99,449.99,'#E8511A',JSON.stringify(['Tudo do Essencial','Definição de objetivos','Análise semanal','VO2max e intervalos','Suporte diário','Videochamada mensal'])]
    ];
    for (const p of plans) {
      await query('INSERT INTO coaching_plans (id,name,slug,tagline,description,price_month,price_year,color,features) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', p);
    }
    console.log('✅ Plans seeded');
  }
  console.log('✅ PostgreSQL ready');
}

module.exports = { query, initDB, uuidv4 };
