// src/routes.js — RunMate API Routes
const express = require('express');
const bcrypt = require('bcryptjs');
// UUID v4 generator (no external dependency needed)
function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}
const db = require('./db');
const { signToken, authMiddleware, haversine } = require('./auth');

const router = express.Router();

// ══════════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════════

// POST /api/auth/register
router.post('/auth/register', (req, res) => {
  try {
    const { name, email, password, city, pace, distance, schedule, goal, level } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: 'Nome, email e password são obrigatórios' });

    if (db.prepare('SELECT id FROM users WHERE email=?').get(email))
      return res.status(409).json({ error: 'Email já registado' });

    const id = uuidv4();
    const hash = bcrypt.hashSync(password, 10);
    const avatar = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);

    db.prepare(`
      INSERT INTO users (id,name,email,password,city,pace,distance,schedule,goal,level,avatar)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(id, name, email, hash, city||'', pace||'', distance||'', schedule||'', goal||'', level||'iniciante', avatar);

    const token = signToken(id);
    const user = safeUser(db.prepare('SELECT * FROM users WHERE id=?').get(id));
    res.json({ token, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/login
router.post('/auth/login', (req, res) => {
  try {
    const { email, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (!user || !bcrypt.compareSync(password, user.password))
      return res.status(401).json({ error: 'Credenciais inválidas' });

    db.prepare("UPDATE users SET last_seen=datetime('now') WHERE id=?").run(user.id);
    res.json({ token: signToken(user.id), user: safeUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me
router.get('/auth/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'Utilizador não encontrado' });
  res.json(safeUser(user));
});

// PATCH /api/auth/me
router.patch('/auth/me', authMiddleware, (req, res) => {
  const allowed = ['name','city','pace','distance','schedule','goal','level','available','bio','radius_km'];
  const fields = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'Nada para atualizar' });

  const sets = fields.map(f => `${f}=?`).join(',');
  const vals = fields.map(f => req.body[f]);
  db.prepare(`UPDATE users SET ${sets} WHERE id=?`).run(...vals, req.userId);

  // Update avatar if name changed
  if (req.body.name) {
    const avatar = req.body.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    db.prepare('UPDATE users SET avatar=? WHERE id=?').run(avatar, req.userId);
  }

  res.json(safeUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.userId)));
});

function safeUser(u) {
  if (!u) return null;
  const { password, ...safe } = u;
  return safe;
}

// ══════════════════════════════════════════════════
//  GPS — LOCATION UPDATES
// ══════════════════════════════════════════════════

// POST /api/location — update my GPS position
router.post('/location', authMiddleware, (req, res) => {
  try {
    const { lat, lng, accuracy, heading, speed, is_running } = req.body;
    if (!lat || !lng) return res.status(400).json({ error: 'lat e lng são obrigatórios' });

    // Upsert location
    db.prepare(`
      INSERT INTO locations (user_id, lat, lng, accuracy, heading, speed, is_running, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET
        lat=excluded.lat, lng=excluded.lng,
        accuracy=excluded.accuracy, heading=excluded.heading,
        speed=excluded.speed, is_running=excluded.is_running,
        updated_at=excluded.updated_at
    `).run(req.userId, lat, lng, accuracy||0, heading||0, speed||0, is_running?1:0);

    // Also update user's last known position and last_seen
    db.prepare(`UPDATE users SET lat=?, lng=?, last_seen=datetime('now') WHERE id=?`).run(lat, lng, req.userId);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/users — ALL registered users
router.get('/admin/users', authMiddleware, (req, res) => {
  try {
    const users = db.prepare(`
      SELECT u.id, u.name, u.email, u.city, u.lat, u.lng,
             u.pace, u.distance, u.schedule, u.goal, u.level,
             u.available, u.avatar, u.km_year, u.races_done,
             u.last_seen, u.created_at,
             l.lat as gps_lat, l.lng as gps_lng,
             l.is_running, l.speed, l.updated_at as gps_updated
      FROM users u
      LEFT JOIN locations l ON l.user_id = u.id
      ORDER BY u.created_at DESC
    `).all();
    res.json(users);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/stats — app statistics
router.get('/admin/stats', authMiddleware, (req, res) => {
  try {
    const totalUsers  = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
    const todayUsers  = db.prepare("SELECT COUNT(*) as n FROM users WHERE created_at > datetime('now','-1 day')").get().n;
    const onlineUsers = db.prepare("SELECT COUNT(*) as n FROM locations WHERE updated_at > datetime('now','-30 minutes')").get().n;
    const totalMsgs   = db.prepare('SELECT COUNT(*) as n FROM messages').get().n;
    const totalRaces  = db.prepare('SELECT COUNT(*) as n FROM races').get().n;
    const totalSubs   = db.prepare("SELECT COUNT(*) as n FROM coaching_subscriptions WHERE status='active'").get().n;
    res.json({ totalUsers, todayUsers, onlineUsers, totalMsgs, totalRaces, totalSubs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/location/nearby — get runners near me
router.get('/location/nearby', authMiddleware, (req, res) => {
  try {
    const me = db.prepare('SELECT lat, lng, radius_km FROM users WHERE id=?').get(req.userId);
    if (!me) return res.status(404).json({ error: 'Utilizador não encontrado' });

    const radius = me.radius_km || 15;

    // Get all users with recent locations (last 30 min)
    const users = db.prepare(`
      SELECT u.id, u.name, u.avatar, u.city, u.pace, u.distance, u.schedule,
             u.goal, u.level, u.available, u.bio, u.last_seen,
             l.lat, l.lng, l.is_running, l.speed, l.updated_at as loc_updated
      FROM users u
      LEFT JOIN locations l ON l.user_id = u.id
      WHERE u.id != ?
      AND (l.updated_at > datetime('now', '-30 minutes') OR l.updated_at IS NULL)
    `).all(req.userId);

    const nearby = users
      .map(u => {
        const ulat = u.lat || 41.1579;
        const ulng = u.lng || -8.6291;
        const dist = Math.round(haversine(me.lat, me.lng, ulat, ulng) * 10) / 10;
        return { ...u, dist_km: dist };
      })
      .filter(u => u.dist_km <= radius)
      .sort((a, b) => a.dist_km - b.dist_km);

    res.json(nearby);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════
//  GPS — RUN TRACKING
// ══════════════════════════════════════════════════

// POST /api/tracks/start — start a new run
router.post('/tracks/start', authMiddleware, (req, res) => {
  try {
    const { partner_id } = req.body;
    const id = uuidv4();
    db.prepare(`
      INSERT INTO tracks (id, user_id, partner_id, started_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run(id, req.userId, partner_id || null);
    res.json({ track_id: id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tracks/:id/point — add GPS point to run
router.post('/tracks/:id/point', authMiddleware, (req, res) => {
  try {
    const { lat, lng, speed } = req.body;
    db.prepare(`
      INSERT INTO track_points (track_id, lat, lng, timestamp, speed)
      VALUES (?, ?, ?, datetime('now'), ?)
    `).run(req.params.id, lat, lng, speed || 0);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tracks/:id/finish — finish a run
router.post('/tracks/:id/finish', authMiddleware, (req, res) => {
  try {
    const { distance_km, duration_sec, avg_pace } = req.body;

    db.prepare(`
      UPDATE tracks SET
        ended_at=datetime('now'),
        distance_km=?, duration_sec=?, avg_pace=?
      WHERE id=? AND user_id=?
    `).run(distance_km||0, duration_sec||0, avg_pace||'', req.params.id, req.userId);

    // Update user's yearly km
    db.prepare('UPDATE users SET km_year = km_year + ? WHERE id=?').run(distance_km||0, req.userId);

    const track = db.prepare('SELECT * FROM tracks WHERE id=?').get(req.params.id);
    res.json(track);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tracks — my run history
router.get('/tracks', authMiddleware, (req, res) => {
  try {
    const tracks = db.prepare(`
      SELECT t.*, u.name as partner_name, u.avatar as partner_avatar
      FROM tracks t
      LEFT JOIN users u ON u.id = t.partner_id
      WHERE t.user_id=? AND t.ended_at IS NOT NULL
      ORDER BY t.started_at DESC
      LIMIT 20
    `).all(req.userId);
    res.json(tracks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════
//  MESSAGES
// ══════════════════════════════════════════════════

// GET /api/messages/conversations
router.get('/messages/conversations', authMiddleware, (req, res) => {
  try {
    // Group message (latest)
    const groupMsg = db.prepare(`
      SELECT m.*, u.name as from_name, u.avatar as from_avatar
      FROM messages m JOIN users u ON u.id=m.from_user
      WHERE m.is_group=1
      ORDER BY m.created_at DESC LIMIT 1
    `).get();

    // Private conversations
    const convs = db.prepare(`
      SELECT m.body, m.created_at, m.read, m.from_user, m.to_user,
        CASE WHEN m.from_user=? THEN m.to_user ELSE m.from_user END as other_id,
        u.name as other_name, u.avatar as other_avatar, u.available,
        (SELECT COUNT(*) FROM messages WHERE to_user=? AND from_user=other_id AND read=0) as unread
      FROM messages m
      JOIN users u ON u.id = (CASE WHEN m.from_user=? THEN m.to_user ELSE m.from_user END)
      WHERE (m.from_user=? OR m.to_user=?) AND m.is_group=0
      GROUP BY other_id
      ORDER BY m.created_at DESC
    `).all(req.userId, req.userId, req.userId, req.userId, req.userId);

    res.json({ group: groupMsg, private: convs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/messages/group
router.get('/messages/group', authMiddleware, (req, res) => {
  try {
    const msgs = db.prepare(`
      SELECT m.*, u.name as from_name, u.avatar as from_avatar
      FROM messages m JOIN users u ON u.id=m.from_user
      WHERE m.is_group=1
      ORDER BY m.created_at ASC
      LIMIT 100
    `).all();
    res.json(msgs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/messages/:userId — private chat
router.get('/messages/:userId', authMiddleware, (req, res) => {
  try {
    const msgs = db.prepare(`
      SELECT m.*, u.name as from_name, u.avatar
      FROM messages m JOIN users u ON u.id=m.from_user
      WHERE ((m.from_user=? AND m.to_user=?) OR (m.from_user=? AND m.to_user=?))
        AND m.is_group=0
      ORDER BY m.created_at ASC
    `).all(req.userId, req.params.userId, req.params.userId, req.userId);

    db.prepare('UPDATE messages SET read=1 WHERE from_user=? AND to_user=? AND is_group=0')
      .run(req.params.userId, req.userId);

    res.json(msgs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/messages — send message (private or group)
router.post('/messages', authMiddleware, (req, res) => {
  try {
    const { to_user, body, is_group } = req.body;
    if (!body) return res.status(400).json({ error: 'Mensagem não pode estar vazia' });
    if (!is_group && !to_user) return res.status(400).json({ error: 'Destinatário obrigatório' });

    const id = uuidv4();
    db.prepare(`
      INSERT INTO messages (id, from_user, to_user, is_group, body)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, req.userId, to_user || null, is_group ? 1 : 0, body);

    res.json(db.prepare('SELECT * FROM messages WHERE id=?').get(id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/messages/unread/count
router.get('/messages/unread/count', authMiddleware, (req, res) => {
  try {
    const { n } = db.prepare('SELECT COUNT(*) as n FROM messages WHERE to_user=? AND read=0').get(req.userId);
    res.json({ count: n });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════
//  RACES
// ══════════════════════════════════════════════════

// GET /api/races
router.get('/races', authMiddleware, (req, res) => {
  try {
    const races = db.prepare(`
      SELECT r.*,
        (SELECT COUNT(*) FROM race_participants WHERE race_id=r.id) as going_count,
        (SELECT 1 FROM race_participants WHERE race_id=r.id AND user_id=?) as i_joined
      FROM races r ORDER BY race_date ASC
    `).all(req.userId);

    const result = races.map(race => ({
      ...race,
      participants: db.prepare(`
        SELECT u.id, u.name, u.avatar, u.city
        FROM race_participants rp JOIN users u ON u.id=rp.user_id
        WHERE rp.race_id=?
      `).all(race.id)
    }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/races
router.post('/races', authMiddleware, (req, res) => {
  try {
    const { name, type, distance_km, distance_label, race_date, location } = req.body;
    if (!name) return res.status(400).json({ error: 'Nome obrigatório' });

    const id = uuidv4();
    db.prepare(`
      INSERT INTO races (id,name,type,distance_km,distance_label,race_date,location,created_by)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(id, name, type||'road', distance_km||null, distance_label||'', race_date||'', location||'', req.userId);

    res.json(db.prepare('SELECT * FROM races WHERE id=?').get(id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/races/:id/join — toggle join/leave
router.post('/races/:id/join', authMiddleware, (req, res) => {
  try {
    const existing = db.prepare('SELECT 1 FROM race_participants WHERE race_id=? AND user_id=?')
      .get(req.params.id, req.userId);

    if (existing) {
      db.prepare('DELETE FROM race_participants WHERE race_id=? AND user_id=?').run(req.params.id, req.userId);
      db.prepare('UPDATE users SET races_done = MAX(0, races_done - 1) WHERE id=?').run(req.userId);
      return res.json({ joined: false });
    }

    db.prepare('INSERT INTO race_participants (race_id,user_id) VALUES (?,?)').run(req.params.id, req.userId);
    db.prepare('UPDATE users SET races_done = races_done + 1 WHERE id=?').run(req.userId);
    res.json({ joined: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════
//  INVITES
// ══════════════════════════════════════════════════

// POST /api/invites
router.post('/invites', authMiddleware, (req, res) => {
  try {
    const { to_user, message } = req.body;
    const id = uuidv4();
    db.prepare('INSERT INTO invites (id,from_user,to_user,message) VALUES (?,?,?,?)').run(id, req.userId, to_user, message||'');

    // Also send a message
    db.prepare('INSERT INTO messages (id,from_user,to_user,body) VALUES (?,?,?,?)').run(
      uuidv4(), req.userId, to_user,
      message || 'Olá! Queres fazer um treino juntos?'
    );

    res.json({ ok: true, invite_id: id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/invites/received
router.get('/invites/received', authMiddleware, (req, res) => {
  try {
    const invites = db.prepare(`
      SELECT i.*, u.name as from_name, u.avatar, u.pace, u.distance, u.city
      FROM invites i JOIN users u ON u.id=i.from_user
      WHERE i.to_user=? AND i.status='pending'
      ORDER BY i.created_at DESC
    `).all(req.userId);
    res.json(invites);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════
//  COACHING
// ══════════════════════════════════════════════════

// GET /api/coaching/plans
router.get('/coaching/plans', authMiddleware, (req, res) => {
  try {
    const plans = db.prepare('SELECT * FROM coaching_plans ORDER BY price_month ASC').all();
    res.json(plans.map(p => ({ ...p, features: JSON.parse(p.features || '[]') })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/coaching/subscription
router.get('/coaching/subscription', authMiddleware, (req, res) => {
  try {
    const sub = db.prepare(`
      SELECT cs.*, cp.name as plan_name, cp.slug, cp.color, cp.price_month, cp.price_year, cp.features
      FROM coaching_subscriptions cs
      JOIN coaching_plans cp ON cp.id=cs.plan_id
      WHERE cs.user_id=? AND cs.status='active'
      ORDER BY cs.started_at DESC LIMIT 1
    `).get(req.userId);

    if (!sub) return res.json(null);
    res.json({ ...sub, features: JSON.parse(sub.features || '[]') });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/coaching/subscribe
router.post('/coaching/subscribe', authMiddleware, (req, res) => {
  try {
    const { plan_id, billing } = req.body;
    const plan = db.prepare('SELECT * FROM coaching_plans WHERE id=?').get(plan_id);
    if (!plan) return res.status(404).json({ error: 'Plano não encontrado' });

    // Cancel any existing
    db.prepare("UPDATE coaching_subscriptions SET status='cancelled', cancelled_at=datetime('now') WHERE user_id=? AND status='active'")
      .run(req.userId);

    const id = uuidv4();
    const renews = new Date();
    renews.setMonth(renews.getMonth() + (billing === 'yearly' ? 12 : 1));

    db.prepare('INSERT INTO coaching_subscriptions (id,user_id,plan_id,billing,renews_at) VALUES (?,?,?,?,?)')
      .run(id, req.userId, plan_id, billing || 'monthly', renews.toISOString());

    // Generate workouts for 4 weeks
    generateWorkouts(id, req.userId, plan.slug);

    const sub = db.prepare(`
      SELECT cs.*, cp.name as plan_name, cp.slug, cp.color, cp.price_month, cp.features
      FROM coaching_subscriptions cs JOIN coaching_plans cp ON cp.id=cs.plan_id WHERE cs.id=?
    `).get(id);

    res.json({ ...sub, features: JSON.parse(sub.features || '[]') });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/coaching/workouts?week=N
router.get('/coaching/workouts', authMiddleware, (req, res) => {
  try {
    const week = parseInt(req.query.week) || 1;
    const sub = db.prepare("SELECT id FROM coaching_subscriptions WHERE user_id=? AND status='active' LIMIT 1").get(req.userId);
    if (!sub) return res.json([]);
    res.json(db.prepare('SELECT * FROM coaching_workouts WHERE sub_id=? AND week_num=? ORDER BY day_of_week ASC').all(sub.id, week));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/coaching/workouts/:id/complete
router.patch('/coaching/workouts/:id/complete', authMiddleware, (req, res) => {
  try {
    db.prepare("UPDATE coaching_workouts SET completed=1, completed_at=datetime('now'), notes_athlete=? WHERE id=? AND user_id=?")
      .run(req.body.notes || '', req.params.id, req.userId);
    res.json(db.prepare('SELECT * FROM coaching_workouts WHERE id=?').get(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/coaching/messages
router.get('/coaching/messages', authMiddleware, (req, res) => {
  try {
    const sub = db.prepare("SELECT id FROM coaching_subscriptions WHERE user_id=? AND status='active' LIMIT 1").get(req.userId);
    if (!sub) return res.json([]);
    res.json(db.prepare('SELECT * FROM coaching_messages WHERE sub_id=? ORDER BY created_at ASC').all(sub.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/coaching/messages
router.post('/coaching/messages', authMiddleware, (req, res) => {
  try {
    const { body } = req.body;
    const sub = db.prepare("SELECT id FROM coaching_subscriptions WHERE user_id=? AND status='active' LIMIT 1").get(req.userId);
    if (!sub) return res.status(404).json({ error: 'Sem subscrição ativa' });

    const id = uuidv4();
    db.prepare('INSERT INTO coaching_messages (id,sub_id,from_coach,body) VALUES (?,?,0,?)').run(id, sub.id, body);

    // Simulated coach reply (in production: real coach or AI)
    setTimeout(() => {
      const replies = [
        'Ótimo trabalho! Continua assim 💪',
        'Recebido! Vou analisar e ajustar o plano.',
        'Perfeita intensidade para esta fase de treino.',
        'Excelente consistência. Mantém o ritmo!',
      ];
      const reply = replies[Math.floor(Math.random() * replies.length)];
      db.prepare('INSERT INTO coaching_messages (id,sub_id,from_coach,body) VALUES (?,?,1,?)').run(uuidv4(), sub.id, reply);
    }, 3000);

    res.json(db.prepare('SELECT * FROM coaching_messages WHERE id=?').get(id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/coaching/goals
router.post('/coaching/goals', authMiddleware, (req, res) => {
  try {
    const { race_name, target_time, race_date, current_pb, notes } = req.body;
    const id = uuidv4();
    db.prepare('INSERT INTO athlete_goals (id,user_id,race_name,target_time,race_date,current_pb,notes) VALUES (?,?,?,?,?,?,?)')
      .run(id, req.userId, race_name, target_time, race_date, current_pb, notes);
    res.json(db.prepare('SELECT * FROM athlete_goals WHERE id=?').get(id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/coaching/goals
router.get('/coaching/goals', authMiddleware, (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM athlete_goals WHERE user_id=? ORDER BY created_at DESC').all(req.userId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/coaching/cancel
router.post('/coaching/cancel', authMiddleware, (req, res) => {
  try {
    db.prepare("UPDATE coaching_subscriptions SET status='cancelled', cancelled_at=datetime('now') WHERE user_id=? AND status='active'")
      .run(req.userId);
    res.json({ cancelled: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════
//  WORKOUT GENERATOR
// ══════════════════════════════════════════════════
function generateWorkouts(subId, userId, planSlug) {
  const templates = {
    essencial: [
      [1,'Corrida Fácil','easy','Ritmo confortável onde consegues manter conversa. Foca na cadência.',5,35,'low'],
      [2,'Descanso Ativo','rest','Caminhada leve 20-30 min ou mobilidade.',0,20,'low'],
      [3,'Corrida de Ritmo','tempo','Ligeiramente desconfortável. Mantém o ritmo constante.',6,38,'medium'],
      [4,'Descanso','rest','Recuperação total.',0,0,'low'],
      [5,'Intervalos Suaves','intervals','6×3min forte + 2min recuperação. Regista os tempos.',7,45,'medium'],
      [6,'Corrida Longa','long','Ritmo muito lento. O objetivo é o tempo em pé.',12,75,'low'],
      [7,'Descanso','rest','Descanso completo.',0,0,'low'],
    ],
    elite: [
      [1,'Corrida Fácil','easy','8km zona 2. Cadência 178-182spm. Postura e eficiência.',8,50,'low'],
      [2,'Força & Core','cross','Lunges, step-ups, plank, dead bugs. 3 séries.',0,40,'medium'],
      [3,'Treino Tempo','tempo','2km aq + 6km ritmo de prova + 2km cool down.',10,55,'high'],
      [4,'Recuperação Ativa','rest','4km leves + 10min mobilidade.',4,30,'low'],
      [5,'Intervalos VO2max','intervals','10×400m máximo sustentável, 90s rec. Regista splits.',8,50,'high'],
      [6,'Longa Progressiva','long','20km: primeiros 10 fáceis, últimos 10 a ritmo de meia.',20,110,'medium'],
      [7,'Descanso Total','rest','Recuperação total.',0,0,'low'],
    ]
  };

  const tmpl = templates[planSlug] || templates.essencial;
  const insert = db.prepare(`
    INSERT INTO coaching_workouts
      (id,sub_id,user_id,week_num,day_of_week,title,type,description,distance_km,duration_min,intensity)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `);

  for (let w = 1; w <= 4; w++) {
    const f = 1 + (w - 1) * 0.1; // 10% progressive overload per week
    tmpl.forEach(([day, title, type, desc, dist, dur, intensity]) => {
      insert.run(
        uuidv4(), subId, userId, w, day, title, type, desc,
        Math.round(dist * f * 10) / 10,
        Math.round(dur * f),
        intensity
      );
    });
  }
}

module.exports = router;
