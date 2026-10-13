const readline = require('readline');
const bcrypt = require('bcrypt');
const pool = require('../src/database');

async function main() {
  const { rows: roles } = await pool.query('SELECT id, name FROM roles ORDER BY id');
  if (roles.length === 0) {
    throw new Error('No roles found in database. Run the migration first (database/migrations/001_auth.sql).');
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (question) => {
    process.stdout.write(question);
    const { value } = await lines.next();
    return String(value ?? '').trim();
  };

  try {
    console.log('Available roles:');
    for (const role of roles) {
      console.log(`  ${role.id} - ${role.name}`);
    }

    const username = await ask('Username: ');
    if (!username) {
      throw new Error('Username is required.');
    }

    const password = await ask('Password: ');
    if (!password) {
      throw new Error('Password is required.');
    }

    const roleId = Number(await ask('Role id: '));
    const role = roles.find((r) => r.id === roleId);
    if (!role) {
      throw new Error('Invalid role id.');
    }

    const { rows: existing } = await pool.query('SELECT 1 FROM users WHERE username = $1', [username]);
    if (existing.length > 0) {
      throw new Error(`User "${username}" already exists.`);
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await pool.query('INSERT INTO users (username, password_hash, role_id) VALUES ($1, $2, $3)', [
      username,
      passwordHash,
      roleId,
    ]);

    console.log(`Account "${username}" created with role "${role.name}".`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  } finally {
    rl.close();
    await pool.end();
  }
}

main();
