const app = require('./app');
const config = require('./config');

app.listen(config.port,'0.0.0.0', () => {
  console.log(`Server listening on port ${config.port}`);
});
