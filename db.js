const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://sparky:aswinsparky@cluster0.wjamxsc.mongodb.net/?appName=Cluster0';
const DB_NAME = process.env.DB_NAME || 'plavaswin';

let client = null;
let db = null;
let usersCollection = null;
let isConnected = false;

// Fallback in-memory store if MongoDB is temporarily unavailable or during setup
const memoryUsers = new Map();

async function connectDB() {
  if (isConnected && db) return db;

  try {
    client = new MongoClient(MONGODB_URI, {
      serverSelectionTimeoutMS: 4000,
      connectTimeoutMS: 5000
    });

    await client.connect();
    db = client.db(DB_NAME);
    usersCollection = db.collection('users');

    // Ensure unique index on username
    await usersCollection.createIndex({ username: 1 }, { unique: true }).catch(() => {});
    // Ensure index on telegramId
    await usersCollection.createIndex({ telegramId: 1 }).catch(() => {});

    isConnected = true;
    console.log(`[Database] MongoDB successfully connected to ${DB_NAME}`);
    return db;
  } catch (err) {
    console.warn(`[Database] MongoDB connection warning (${err.message}). Using hybrid fallback.`);
    isConnected = false;
    return null;
  }
}

/**
 * Register or update user with a 3-day access key
 */
async function registerUser({ username, password, telegramId, telegramUsername, daysValid = 3 }) {
  const cleanUsername = String(username).trim().toLowerCase();
  const hashedPassword = await bcrypt.hash(password, 10);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + daysValid * 24 * 60 * 60 * 1000);

  const userData = {
    username: cleanUsername,
    password: hashedPassword,
    plainPasswordHint: password.slice(0, 2) + '****',
    telegramId: telegramId ? String(telegramId) : null,
    telegramUsername: telegramUsername || '',
    createdAt: now,
    expiresAt: expiresAt,
    daysValid: daysValid,
    isActive: true
  };

  if (isConnected && usersCollection) {
    try {
      await usersCollection.updateOne(
        { username: cleanUsername },
        { $set: userData },
        { upsert: true }
      );
      return { success: true, user: userData };
    } catch (err) {
      console.error('[Database] Error saving user to MongoDB:', err.message);
    }
  }

  // Fallback to in-memory store
  memoryUsers.set(cleanUsername, userData);
  return { success: true, user: userData };
}

/**
 * Find user by username
 */
async function findUser(username) {
  const cleanUsername = String(username).trim().toLowerCase();

  if (isConnected && usersCollection) {
    try {
      const user = await usersCollection.findOne({ username: cleanUsername });
      if (user) return user;
    } catch (err) {
      console.error('[Database] Find user error:', err.message);
    }
  }

  return memoryUsers.get(cleanUsername) || null;
}

/**
 * Verify user credentials and check 7-day expiration
 */
async function verifyCredentials(username, password) {
  if (!username || !password) {
    return { valid: false, error: 'Username and password are required' };
  }

  const cleanUsername = String(username).trim().toLowerCase();
  const user = await findUser(cleanUsername);

  if (!user) {
    return { valid: false, error: 'Account not found. Get your key from our Telegram bot!' };
  }

  // Check password
  const isMatch = await bcrypt.compare(password, user.password).catch(() => false);
  if (!isMatch && user.password !== password) {
    return { valid: false, error: 'Invalid password' };
  }

  // Check expiration (3-day validity)
  const now = new Date();
  const expiry = new Date(user.expiresAt);

  if (now > expiry) {
    return {
      valid: false,
      expired: true,
      error: 'Access Key has expired (3-day validity ended). Please generate a new key on our Telegram bot!'
    };
  }

  // Calculate days remaining
  const msRemaining = expiry.getTime() - now.getTime();
  const daysRemaining = Math.max(1, Math.ceil(msRemaining / (1000 * 60 * 60 * 24)));

  return {
    valid: true,
    user: {
      username: user.username,
      expiresAt: user.expiresAt,
      daysRemaining: daysRemaining
    }
  };
}

module.exports = {
  connectDB,
  registerUser,
  findUser,
  verifyCredentials,
  getIsConnected: () => isConnected
};
