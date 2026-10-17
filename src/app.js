const express = require('express');
const app = express();
const session = require('express-session');
const config = require('./config');
const authRoutes = require('./modules/auth');
const importRoutes = require('./modules/imports');
const masterDataRoutes = require('./modules/master-data');
const randomizationRoutes = require('./modules/randomization/routes');
const { createAppStage1Router } = require('./modules/randomization-stage-1/wiring');
const notificationRoutes = require('./modules/notifications');
const reportsRoutes = require('./modules/reports');
const trainingRoutes = require('./modules/training');

// Increased body limit to support large Excel uploads (10k+ personnel rows can be several MB)
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
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
