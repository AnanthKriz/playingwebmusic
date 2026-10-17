require('dotenv').config();
const { connectDB, registerUser } = require('./db');

async function main() {
  const args = process.argv.slice(2);
  const username = args[0] || 'aswinsparky';
  const password = args[1] || 'kichu777';
  const days = parseInt(args[2] || '3', 10);

  console.log(`Connecting to database and generating key for: ${username}...`);
  await connectDB();

  const res = await registerUser({
    username,
    password,
    telegramId: 'admin_cli',
    telegramUsername: 'admin',
    daysValid: days
  });

  const expiry = new Date(res.user.expiresAt).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });

  console.log('\n==================================================');
  console.log(`  KEY GENERATED SUCCESSFULLY (${days}-DAY ACCESS)`);
  console.log(`  Username: ${res.user.username}`);
  console.log(`  Password: ${password}`);
  console.log(`  Valid for: ${days} days (Expires: ${expiry})`);
  console.log('==================================================\n');
  process.exit(0);
}

main().catch(err => {
  console.error('Failed to create key:', err);
  process.exit(1);
});
