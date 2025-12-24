const initSqlJs = require('sql.js');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const DB_PATH = './database.sqlite';

async function initDatabase() {
  const SQL = await initSqlJs();

  let db;
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      is_suspended INTEGER DEFAULT 0,
      suspension_reason TEXT,
      suspension_until DATETIME,
      malicious_detected INTEGER DEFAULT 0,
      folder_id TEXT UNIQUE NOT NULL,
      access_key TEXT UNIQUE NOT NULL,
      secret_key TEXT NOT NULL,
      storage_limit_mb INTEGER DEFAULT 1024,
      storage_used_mb REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      amount_huf INTEGER NOT NULL,
      storage_mb INTEGER NOT NULL,
      paypal_order_id TEXT,
      paypal_payer_email TEXT,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS storage_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      file_path TEXT,
      file_size_bytes INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // Create admin user if not exists
  const adminEmail = process.env.ADMIN_EMAIL || 'egyeb@geri-888.hu';
  const adminPassword = process.env.ADMIN_PASSWORD || 'asd';

  const result = db.exec(`SELECT * FROM users WHERE email = '${adminEmail}'`);

  const hashedPassword = bcrypt.hashSync(adminPassword, 10);

  if (result.length === 0 || result[0].values.length === 0) {
    const adminId = uuidv4();
    const folderId = uuidv4().replace(/-/g, '');
    const accessKey = 'AK' + uuidv4().replace(/-/g, '').toUpperCase().substring(0, 20);
    const secretKey = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');

    db.run(`
      INSERT INTO users (id, email, password, is_admin, folder_id, access_key, secret_key, storage_limit_mb)
      VALUES (?, ?, ?, 1, ?, ?, ?, 999999999)
    `, [adminId, adminEmail, hashedPassword, folderId, accessKey, secretKey]);

    console.log('Admin user created:', adminEmail);
  } else {
    // Update admin password if user exists
    db.run(`UPDATE users SET password = ?, is_admin = 1 WHERE email = ?`, [hashedPassword, adminEmail]);
    console.log('Admin user password updated:', adminEmail);
  }

  // Save database
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);

  console.log('Database initialized successfully!');
  db.close();
}

initDatabase().catch(console.error);
