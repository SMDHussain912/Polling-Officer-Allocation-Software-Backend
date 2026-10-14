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
};
