// src/server.js — RunMate API Server
const express = require('express');
const cors = require('cors');
const path = require('path');
const routes = require('./routes');

const app = express();
const PORT = process.env.PORT || 3000;

// ── MIDDLEWARE ───────────────────────────────────
app.use(cors({
  origin: '*', // In production: set to your Netlify URL
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '1mb' }));

// ── REQUEST LOGGER (dev) ─────────────────────────
if (process.env.NODE_ENV !== 'production') {
  app.use((req, _res, next) => {
    console.log(`${req.method} ${req.path}`);
    next();
  });
}

// ── API ROUTES ───────────────────────────────────
app.use('/api', routes);

// ── HEALTH CHECK ─────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    app: 'RunMate API',
    version: '2.0.0',
    time: new Date().toISOString()
  });
});

// ── START ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n🏃 RunMate API v2.0');
  console.log(`📡 http://localhost:${PORT}`);
  console.log('\n📚 Endpoints:');
  [
    'POST /api/auth/register',
    'POST /api/auth/login',
    'GET  /api/auth/me',
    'PATCH /api/auth/me',
    'POST /api/location',
    'GET  /api/location/nearby',
    'POST /api/tracks/start',
    'POST /api/tracks/:id/point',
    'POST /api/tracks/:id/finish',
    'GET  /api/tracks',
    'GET  /api/messages/conversations',
    'GET  /api/messages/group',
    'GET  /api/messages/:userId',
    'POST /api/messages',
    'GET  /api/races',
    'POST /api/races',
    'POST /api/races/:id/join',
    'POST /api/invites',
    'GET  /api/invites/received',
    'GET  /api/coaching/plans',
    'POST /api/coaching/subscribe',
    'GET  /api/coaching/workouts',
    'POST /api/coaching/messages',
    'POST /api/coaching/goals',
  ].forEach(e => console.log('   ' + e));
  console.log('');
});

module.exports = app;
