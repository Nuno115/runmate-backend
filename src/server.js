// src/server.js — RunMate API Server (PostgreSQL)
const express = require('express');
const cors = require('cors');
const { initDB } = require('./db');
const routes = require('./routes');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET','POST','PUT','PATCH','DELETE'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json({ limit: '1mb' }));

app.use('/api', routes);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', app: 'RunMate API', version: '3.0.0', db: 'PostgreSQL', time: new Date().toISOString() });
});

// Start server after DB is ready
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🏃 RunMate API v3.0 (PostgreSQL)`);
    console.log(`📡 http://localhost:${PORT}\n`);
  });
}).catch(err => {
  console.error('❌ DB init failed:', err.message);
  process.exit(1);
});

module.exports = app;
