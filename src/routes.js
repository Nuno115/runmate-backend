// src/routes.js — RunMate API Routes (PostgreSQL)
const express = require('express');
const bcrypt = require('bcryptjs');
const https = require('https');
const { query, uuidv4 } = require('./db');
const { signToken, authMiddleware, haversine } = require('./auth');

const router = express.Router();

function safeUser(u) {
  if (!u) return null;
  const { password, ...safe } = u;
  return safe;
}

// ══ AUTH ══
router.post('/auth/register', async (req, res) => {
  try {
    const { name, email, password, city, pace, distance, schedule, goal, level } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Nome, email e password são obrigatórios' });
    const existing = await query('SELECT id FROM users WHERE email=$1', [email]);
    if (existing.rows.length) return res.status(409).json({ error: 'Email já registado' });
    const id = uuidv4();
    const hash = bcrypt.hashSync(password, 10);
    const avatar = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0,2);
    await query('INSERT INTO users (id,name,email,password,city,pace,distance,schedule,goal,level,avatar) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [id,name,email,hash,city||'',pace||'',distance||'',schedule||'',goal||'',level||'iniciante',avatar]);
    const user = (await query('SELECT * FROM users WHERE id=$1', [id])).rows[0];
    res.json({ token: signToken(id), user: safeUser(user) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const r = await query('SELECT * FROM users WHERE email=$1', [email]);
    const user = r.rows[0];
    if (!user || !bcrypt.compareSync(password, user.password))
      return res.status(401).json({ error: 'Credenciais inválidas' });
    await query('UPDATE users SET last_seen=NOW() WHERE id=$1', [user.id]);
    res.json({ token: signToken(user.id), user: safeUser(user) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/auth/me', authMiddleware, async (req, res) => {
  try {
    const r = await query('SELECT * FROM users WHERE id=$1', [req.userId]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Não encontrado' });
    res.json(safeUser(r.rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/auth/me', authMiddleware, async (req, res) => {
  try {
    const allowed = ['name','city','pace','distance','schedule','goal','level','available','bio','radius_km'];
    const fields = Object.keys(req.body).filter(k => allowed.includes(k));
    if (!fields.length) return res.status(400).json({ error: 'Nada para atualizar' });
    const sets = fields.map((f,i) => `${f}=$${i+1}`).join(',');
    await query(`UPDATE users SET ${sets} WHERE id=$${fields.length+1}`, [...fields.map(f=>req.body[f]), req.userId]);
    if (req.body.name) {
      const avatar = req.body.name.split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2);
      await query('UPDATE users SET avatar=$1 WHERE id=$2', [avatar, req.userId]);
    }
    const r = await query('SELECT * FROM users WHERE id=$1', [req.userId]);
    res.json(safeUser(r.rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/auth/reset-password', async (req, res) => {
  try {
    const { email, new_password } = req.body;
    if (!email || !new_password) return res.status(400).json({ error: 'Campos obrigatórios' });
    const r = await query('SELECT id FROM users WHERE email=$1', [email]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Email não encontrado' });
    const hash = bcrypt.hashSync(new_password, 10);
    await query('UPDATE users SET password=$1 WHERE email=$2', [hash, email]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══ LOCATION ══
router.post('/location', authMiddleware, async (req, res) => {
  try {
    const { lat, lng, accuracy, heading, speed, is_running } = req.body;
    if (!lat || !lng) return res.status(400).json({ error: 'lat e lng obrigatórios' });
    await query(`INSERT INTO locations (user_id,lat,lng,accuracy,heading,speed,is_running,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
      ON CONFLICT(user_id) DO UPDATE SET lat=$2,lng=$3,accuracy=$4,heading=$5,speed=$6,is_running=$7,updated_at=NOW()`,
      [req.userId,lat,lng,accuracy||0,heading||0,speed||0,is_running?1:0]);
    await query('UPDATE users SET lat=$1,lng=$2,last_seen=NOW() WHERE id=$3', [lat,lng,req.userId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/location/nearby', authMiddleware, async (req, res) => {
  try {
    const meR = await query('SELECT lat,lng,radius_km FROM users WHERE id=$1', [req.userId]);
    const me = meR.rows[0];
    if (!me) return res.status(404).json({ error: 'Não encontrado' });
    const radius = me.radius_km || 15;
    const r = await query(`
      SELECT u.id,u.name,u.avatar,u.city,u.pace,u.distance,u.schedule,u.goal,u.level,u.available,u.bio,u.last_seen,u.email,
             l.lat,l.lng,l.is_running,l.speed,l.updated_at as loc_updated
      FROM users u LEFT JOIN locations l ON l.user_id=u.id
      WHERE u.id!=$1 AND u.email!='admin@runmate.pt'
      AND (l.updated_at > NOW()-INTERVAL '30 minutes' OR l.updated_at IS NULL)
    `, [req.userId]);
    const nearby = r.rows
      .map(u => ({ ...u, dist_km: Math.round(haversine(me.lat,me.lng,u.lat||41.1579,u.lng||-8.6291)*10)/10 }))
      .filter(u => u.dist_km <= radius)
      .sort((a,b) => a.dist_km - b.dist_km);
    res.json(nearby);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══ ADMIN ══
router.get('/admin/users', authMiddleware, async (req, res) => {
  try {
    const r = await query(`SELECT u.*,l.lat as gps_lat,l.lng as gps_lng,l.is_running,l.speed,l.updated_at as gps_updated
      FROM users u LEFT JOIN locations l ON l.user_id=u.id ORDER BY u.created_at DESC`);
    res.json(r.rows.map(safeUser));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/admin/stats', authMiddleware, async (req, res) => {
  try {
    const [u,t,o,m,rc,s] = await Promise.all([
      query('SELECT COUNT(*) as n FROM users'),
      query("SELECT COUNT(*) as n FROM users WHERE created_at>NOW()-INTERVAL '1 day'"),
      query("SELECT COUNT(*) as n FROM locations WHERE updated_at>NOW()-INTERVAL '30 minutes'"),
      query('SELECT COUNT(*) as n FROM messages'),
      query('SELECT COUNT(*) as n FROM races'),
      query("SELECT COUNT(*) as n FROM coaching_subscriptions WHERE status='active'"),
    ]);
    res.json({ totalUsers:+u.rows[0].n, todayUsers:+t.rows[0].n, onlineUsers:+o.rows[0].n,
      totalMsgs:+m.rows[0].n, totalRaces:+rc.rows[0].n, totalSubs:+s.rows[0].n });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══ MESSAGES ══
router.get('/messages/group', authMiddleware, async (req, res) => {
  try {
    const r = await query(`SELECT m.*,u.name as from_name,u.avatar as from_avatar
      FROM messages m JOIN users u ON u.id=m.from_user
      WHERE m.is_group=1 ORDER BY m.created_at ASC LIMIT 100`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/messages/unread/count', authMiddleware, async (req, res) => {
  try {
    const r = await query('SELECT COUNT(*) as n FROM messages WHERE to_user=$1 AND read=0', [req.userId]);
    res.json({ count: +r.rows[0].n });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/messages/conversations', authMiddleware, async (req, res) => {
  try {
    const group = await query(`SELECT m.*,u.name as from_name,u.avatar as from_avatar
      FROM messages m JOIN users u ON u.id=m.from_user
      WHERE m.is_group=1 ORDER BY m.created_at DESC LIMIT 1`);
    const convs = await query(`SELECT DISTINCT ON (other_id)
        m.body,m.created_at,m.read,m.from_user,m.to_user,
        CASE WHEN m.from_user=$1 THEN m.to_user ELSE m.from_user END as other_id,
        u.name as other_name,u.avatar as other_avatar,u.available
      FROM messages m
      JOIN users u ON u.id=(CASE WHEN m.from_user=$1 THEN m.to_user ELSE m.from_user END)
      WHERE (m.from_user=$1 OR m.to_user=$1) AND m.is_group=0
      ORDER BY other_id,m.created_at DESC`, [req.userId]);
    res.json({ group: group.rows[0]||null, private: convs.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/messages/:userId', authMiddleware, async (req, res) => {
  try {
    const r = await query(`SELECT m.*,u.name as from_name,u.avatar
      FROM messages m JOIN users u ON u.id=m.from_user
      WHERE ((m.from_user=$1 AND m.to_user=$2) OR (m.from_user=$2 AND m.to_user=$1)) AND m.is_group=0
      ORDER BY m.created_at ASC`, [req.userId, req.params.userId]);
    await query('UPDATE messages SET read=1 WHERE from_user=$1 AND to_user=$2 AND is_group=0', [req.params.userId, req.userId]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/messages', authMiddleware, async (req, res) => {
  try {
    const { to_user, body, is_group } = req.body;
    if (!body) return res.status(400).json({ error: 'Mensagem vazia' });
    const id = uuidv4();
    await query('INSERT INTO messages (id,from_user,to_user,is_group,body) VALUES ($1,$2,$3,$4,$5)',
      [id, req.userId, to_user||null, is_group?1:0, body]);
    if (!is_group && to_user) {
      const sender = await query('SELECT name FROM users WHERE id=$1', [req.userId]);
      notifyUser(to_user, '💬 '+(sender.rows[0]?.name||'RunMate'), body.slice(0,100), {type:'message'}).catch(()=>{});
    }
    const r = await query('SELECT * FROM messages WHERE id=$1', [id]);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══ RACES ══
router.get('/races', authMiddleware, async (req, res) => {
  try {
    const r = await query(`SELECT r.*,
        (SELECT COUNT(*) FROM race_participants WHERE race_id=r.id) as going_count,
        (SELECT 1 FROM race_participants WHERE race_id=r.id AND user_id=$1) as i_joined
      FROM races r ORDER BY race_date ASC`, [req.userId]);
    const races = await Promise.all(r.rows.map(async race => {
      const p = await query(`SELECT u.id,u.name,u.avatar,u.city FROM race_participants rp
        JOIN users u ON u.id=rp.user_id WHERE rp.race_id=$1`, [race.id]);
      return { ...race, participants: p.rows };
    }));
    res.json(races);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/races', authMiddleware, async (req, res) => {
  try {
    const { name, type, distance_km, distance_label, race_date, location } = req.body;
    if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
    const id = uuidv4();
    await query('INSERT INTO races (id,name,type,distance_km,distance_label,race_date,location,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id,name,type||'road',distance_km||null,distance_label||'',race_date||'',location||'',req.userId]);
    res.json((await query('SELECT * FROM races WHERE id=$1',[id])).rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/races/:id/join', authMiddleware, async (req, res) => {
  try {
    const ex = await query('SELECT 1 FROM race_participants WHERE race_id=$1 AND user_id=$2',[req.params.id,req.userId]);
    if (ex.rows.length) {
      await query('DELETE FROM race_participants WHERE race_id=$1 AND user_id=$2',[req.params.id,req.userId]);
      return res.json({ joined: false });
    }
    await query('INSERT INTO race_participants (race_id,user_id) VALUES ($1,$2)',[req.params.id,req.userId]);
    res.json({ joined: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══ INVITES ══
router.post('/invites', authMiddleware, async (req, res) => {
  try {
    const { to_user, message } = req.body;
    await query('INSERT INTO invites (id,from_user,to_user,message) VALUES ($1,$2,$3,$4)',[uuidv4(),req.userId,to_user,message||'']);
    await query('INSERT INTO messages (id,from_user,to_user,body) VALUES ($1,$2,$3,$4)',
      [uuidv4(),req.userId,to_user,message||'Olá! Queres fazer um treino juntos?']);
    const sender = await query('SELECT name FROM users WHERE id=$1',[req.userId]);
    notifyUser(to_user,'🏃 Convite de treino!',(sender.rows[0]?.name||'RunMate')+' quer correr contigo!',{type:'invite'}).catch(()=>{});
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/invites/received', authMiddleware, async (req, res) => {
  try {
    const r = await query(`SELECT i.*,u.name as from_name,u.avatar,u.pace,u.distance,u.city
      FROM invites i JOIN users u ON u.id=i.from_user
      WHERE i.to_user=$1 AND i.status='pending' ORDER BY i.created_at DESC`, [req.userId]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══ COACHING ══
router.get('/coaching/plans', authMiddleware, async (req, res) => {
  try {
    const r = await query('SELECT * FROM coaching_plans ORDER BY price_month ASC');
    res.json(r.rows.map(p => ({ ...p, features: JSON.parse(p.features||'[]') })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/coaching/subscription', authMiddleware, async (req, res) => {
  try {
    const r = await query(`SELECT cs.*,cp.name as plan_name,cp.slug,cp.color,cp.price_month,cp.features
      FROM coaching_subscriptions cs JOIN coaching_plans cp ON cp.id=cs.plan_id
      WHERE cs.user_id=$1 AND cs.status='active' ORDER BY cs.started_at DESC LIMIT 1`, [req.userId]);
    if (!r.rows[0]) return res.json(null);
    res.json({ ...r.rows[0], features: JSON.parse(r.rows[0].features||'[]') });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/coaching/subscribe', authMiddleware, async (req, res) => {
  try {
    const { plan_id, billing } = req.body;
    const planR = await query('SELECT * FROM coaching_plans WHERE id=$1',[plan_id]);
    if (!planR.rows[0]) return res.status(404).json({ error: 'Plano não encontrado' });
    await query("UPDATE coaching_subscriptions SET status='cancelled',cancelled_at=NOW() WHERE user_id=$1 AND status='active'",[req.userId]);
    const id = uuidv4();
    const renews = new Date();
    renews.setMonth(renews.getMonth()+(billing==='yearly'?12:1));
    await query('INSERT INTO coaching_subscriptions (id,user_id,plan_id,billing,renews_at) VALUES ($1,$2,$3,$4,$5)',
      [id,req.userId,plan_id,billing||'monthly',renews]);
    await generateWorkouts(id,req.userId,planR.rows[0].slug);
    const r = await query(`SELECT cs.*,cp.name as plan_name,cp.slug,cp.color,cp.price_month,cp.features
      FROM coaching_subscriptions cs JOIN coaching_plans cp ON cp.id=cs.plan_id WHERE cs.id=$1`,[id]);
    res.json({ ...r.rows[0], features: JSON.parse(r.rows[0].features||'[]') });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/coaching/workouts', authMiddleware, async (req, res) => {
  try {
    const week = parseInt(req.query.week)||1;
    const subR = await query("SELECT id FROM coaching_subscriptions WHERE user_id=$1 AND status='active' LIMIT 1",[req.userId]);
    if (!subR.rows[0]) return res.json([]);
    const r = await query('SELECT * FROM coaching_workouts WHERE sub_id=$1 AND week_num=$2 ORDER BY day_of_week ASC',[subR.rows[0].id,week]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/coaching/workouts/:id/complete', authMiddleware, async (req, res) => {
  try {
    await query("UPDATE coaching_workouts SET completed=1,completed_at=NOW(),notes_athlete=$1 WHERE id=$2 AND user_id=$3",
      [req.body.notes||'',req.params.id,req.userId]);
    res.json((await query('SELECT * FROM coaching_workouts WHERE id=$1',[req.params.id])).rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/coaching/messages', authMiddleware, async (req, res) => {
  try {
    const subR = await query("SELECT id FROM coaching_subscriptions WHERE user_id=$1 AND status='active' LIMIT 1",[req.userId]);
    if (!subR.rows[0]) return res.json([]);
    res.json((await query('SELECT * FROM coaching_messages WHERE sub_id=$1 ORDER BY created_at ASC',[subR.rows[0].id])).rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/coaching/messages', authMiddleware, async (req, res) => {
  try {
    const subR = await query("SELECT id FROM coaching_subscriptions WHERE user_id=$1 AND status='active' LIMIT 1",[req.userId]);
    if (!subR.rows[0]) return res.status(404).json({ error: 'Sem subscrição' });
    const id = uuidv4();
    await query('INSERT INTO coaching_messages (id,sub_id,from_coach,body) VALUES ($1,$2,0,$3)',[id,subR.rows[0].id,req.body.body]);
    setTimeout(async () => {
      const replies = ['Ótimo trabalho! 💪','Recebido! Vou ajustar o plano.','Perfeita intensidade!','Excelente consistência!'];
      await query('INSERT INTO coaching_messages (id,sub_id,from_coach,body) VALUES ($1,$2,1,$3)',
        [uuidv4(),subR.rows[0].id,replies[Math.floor(Math.random()*replies.length)]]);
    }, 3000);
    res.json((await query('SELECT * FROM coaching_messages WHERE id=$1',[id])).rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/coaching/goals', authMiddleware, async (req, res) => {
  try {
    const { race_name,target_time,race_date,current_pb,notes } = req.body;
    const id = uuidv4();
    await query('INSERT INTO athlete_goals (id,user_id,race_name,target_time,race_date,current_pb,notes) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id,req.userId,race_name,target_time,race_date,current_pb,notes]);
    res.json((await query('SELECT * FROM athlete_goals WHERE id=$1',[id])).rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/coaching/goals', authMiddleware, async (req, res) => {
  try {
    res.json((await query('SELECT * FROM athlete_goals WHERE user_id=$1 ORDER BY created_at DESC',[req.userId])).rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/coaching/cancel', authMiddleware, async (req, res) => {
  try {
    await query("UPDATE coaching_subscriptions SET status='cancelled',cancelled_at=NOW() WHERE user_id=$1 AND status='active'",[req.userId]);
    res.json({ cancelled: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══ NOTIFICATIONS ══
const FIREBASE_PROJECT_ID = 'runmate-54b4c';
const FIREBASE_CLIENT_EMAIL = 'firebase-adminsdk-fbsvc@runmate-54b4c.iam.gserviceaccount.com';

async function getFirebaseAccessToken() {
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY||'').replace(/\\n/g,'\n');
  if (!privateKey) return null;
  const now = Math.floor(Date.now()/1000);
  const header = Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url');
  const payload = Buffer.from(JSON.stringify({iss:FIREBASE_CLIENT_EMAIL,scope:'https://www.googleapis.com/auth/firebase.messaging',aud:'https://oauth2.googleapis.com/token',exp:now+3600,iat:now})).toString('base64url');
  const crypto = require('crypto');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(privateKey,'base64url');
  const jwt = `${header}.${payload}.${signature}`;
  return new Promise((resolve,reject) => {
    const pd = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
    const req2 = https.request({hostname:'oauth2.googleapis.com',path:'/token',method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(pd)}},
      res2=>{let d='';res2.on('data',c=>d+=c);res2.on('end',()=>{try{resolve(JSON.parse(d).access_token);}catch(e){reject(e);}});});
    req2.on('error',reject);req2.write(pd);req2.end();
  });
}

async function sendFCMNotification(fcmToken,title,body,data={}) {
  try {
    const accessToken = await getFirebaseAccessToken();
    if (!accessToken) return false;
    const msg = JSON.stringify({message:{token:fcmToken,notification:{title,body},data,android:{priority:'high'},webpush:{headers:{Urgency:'high'},notification:{icon:'/icon-192.png'}}}});
    return new Promise(resolve=>{
      const req2 = https.request({hostname:'fcm.googleapis.com',path:`/v1/projects/${FIREBASE_PROJECT_ID}/messages:send`,method:'POST',
        headers:{'Authorization':`Bearer ${accessToken}`,'Content-Type':'application/json','Content-Length':Buffer.byteLength(msg)}},
        res2=>{let d='';res2.on('data',c=>d+=c);res2.on('end',()=>{console.log('FCM:',res2.statusCode);resolve(res2.statusCode===200);});});
      req2.on('error',e=>{console.error('FCM:',e.message);resolve(false);});
      req2.write(msg);req2.end();
    });
  } catch(e){console.error('FCM:',e.message);return false;}
}

async function notifyUser(userId,title,body,data={}) {
  try {
    const r = await query('SELECT token FROM fcm_tokens WHERE user_id=$1',[userId]);
    if (r.rows[0]) await sendFCMNotification(r.rows[0].token,title,body,data);
  } catch(e){}
}

router.post('/notifications/token', authMiddleware, async (req,res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token obrigatório' });
    await query('INSERT INTO fcm_tokens (user_id,token,updated_at) VALUES ($1,$2,NOW()) ON CONFLICT(user_id) DO UPDATE SET token=$2,updated_at=NOW()',[req.userId,token]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/notifications/send', authMiddleware, async (req,res) => {
  try {
    const { to_user,title,body,data } = req.body;
    const r = await query('SELECT token FROM fcm_tokens WHERE user_id=$1',[to_user]);
    if (!r.rows[0]) return res.json({ ok:false,reason:'no_token' });
    const sent = await sendFCMNotification(r.rows[0].token,title,body,data||{});
    res.json({ ok: sent });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══ WORKOUT GENERATOR ══
async function generateWorkouts(subId,userId,planSlug) {
  const templates = {
    essencial:[[1,'Corrida Fácil','easy','Ritmo confortável',5,35,'low'],[2,'Descanso Ativo','rest','Caminhada leve',0,20,'low'],[3,'Corrida de Ritmo','tempo','Ligeiramente desconfortável',6,38,'medium'],[4,'Descanso','rest','Recuperação',0,0,'low'],[5,'Intervalos','intervals','6×3min forte',7,45,'medium'],[6,'Corrida Longa','long','Ritmo lento',12,75,'low'],[7,'Descanso','rest','Descanso',0,0,'low']],
    elite:[[1,'Corrida Fácil','easy','8km zona 2',8,50,'low'],[2,'Força','cross','Core e força',0,40,'medium'],[3,'Tempo','tempo','2km aq+6km ritmo+2km cool',10,55,'high'],[4,'Recuperação','rest','4km leves',4,30,'low'],[5,'VO2max','intervals','10×400m',8,50,'high'],[6,'Longa Progressiva','long','20km progressivo',20,110,'medium'],[7,'Descanso','rest','Descanso total',0,0,'low']]
  };
  const tmpl = templates[planSlug]||templates.essencial;
  for (let w=1;w<=4;w++) {
    const f=1+(w-1)*0.1;
    for (const [day,title,type,desc,dist,dur,intensity] of tmpl) {
      await query('INSERT INTO coaching_workouts (id,sub_id,user_id,week_num,day_of_week,title,type,description,distance_km,duration_min,intensity) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [uuidv4(),subId,userId,w,day,title,type,desc,Math.round(dist*f*10)/10,Math.round(dur*f),intensity]);
    }
  }
}

module.exports = router;
