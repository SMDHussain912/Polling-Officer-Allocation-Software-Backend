// Load .env relative to THIS file (src/config/), so startup works regardless
// of the current working directory (project root, backend dir, or anywhere).
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const missing = ['DATABASE_URL', 'SESSION_SECRET'].filter((key) => !process.env[key]);
if (missing.length > 0) {
  throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

module.exports = {
  databaseUrl: process.env.DATABASE_URL,
  sessionSecret: process.env.SESSION_SECRET,
  port: Number(process.env.PORT) || 3000,
  // Dates/times that change between elections (team decision: keep in .env,
  // not DB — edit + restart to change). Frontend shows them read-only.
  training: {
    date: process.env.TRAINING_DATE || '',
    timeFrom: process.env.TRAINING_TIME_FROM || '',
    timeTo: process.env.TRAINING_TIME_TO || '',
  },
  orders: {
    pollingDateTime: process.env.POLLING_DATE_TIME || '',
    distributionCenter: process.env.DISTRIBUTION_CENTER || '',
    distributionReportTime: process.env.DISTRIBUTION_REPORT_TIME || '',
  },
};
