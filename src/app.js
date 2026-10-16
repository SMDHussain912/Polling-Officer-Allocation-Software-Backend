const express = require('express');
const session = require('express-session');
const morgan = require('morgan');
const config = require('./config');
const authRoutes = require('./modules/auth');
const importRoutes = require('./modules/imports');
const masterDataRoutes = require('./modules/master-data');
const randomizationRoutes = require('./modules/randomization/routes');
const { createAppStage1Router } = require('./modules/randomization-stage-1/wiring');
const notificationRoutes = require('./modules/notifications');
const reportsRoutes = require('./modules/reports');
const trainingRoutes = require('./modules/training');

const app = express();

// HTTP request logger (dev: combined-style output; production: same)
// Shows method, URL, status, response time, content-length for every request.
app.use(morgan('dev'));

// Debug: log every incoming request body and headers at the route entry point.
app.use((req, res, next) => {
  if (process.env.DEBUG_REQUESTS === 'true') {
    console.debug('[REQ]', req.method, req.originalUrl, {
      body: req.body,
      query: req.query,
      params: req.params,
      sessionUser: req.session && req.session.user ? req.session.user.id : null,
    });
  }
  next();
});

// 20mb limit matches the imports router's own intent: uploads are base64-JSON
// (~1.37x file size). The app-level default (100kb) would 413 any workbook
// over ~75KB before the route-level parser ever runs.
app.use(express.json({ limit: '20mb' }));
app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 8 },
  })
);

app.use('/api/auth', authRoutes);
app.use('/api/imports', importRoutes);
app.use('/api/master-data', masterDataRoutes);
app.use('/api/randomization/stage-1', createAppStage1Router());
app.use('/api/randomization', randomizationRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/training', trainingRoutes);

module.exports = app;
