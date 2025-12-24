const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const initSqlJs = require('sql.js');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
require('dotenv').config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const DB_PATH = './database.sqlite';

let db = null;

// S3 Client (Central - never exposed to users)
const s3Client = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: 'auto',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY
  },
  forcePathStyle: true
});

const S3_BUCKET = process.env.S3_BUCKET;
const PRICE_PER_GB = parseInt(process.env.PRICE_PER_GB_HUF) || 5;
const PRICE_PER_GB_EUR = parseFloat(process.env.PRICE_PER_GB_EUR) || 0.013;
const PRICE_PER_GB_USD = parseFloat(process.env.PRICE_PER_GB_USD) || 0.014;
const MIN_PURCHASE_GB = parseInt(process.env.MIN_PURCHASE_GB) || 1;
const MAX_PURCHASE_GB = parseInt(process.env.MAX_PURCHASE_GB) || 1000;
const MALICIOUS_PATTERNS = (process.env.MALICIOUS_PATTERNS || 'ddos|hack|exploit|malware').split('|').map(p => new RegExp(p, 'i'));
const CURRENCY_API_URL = process.env.CURRENCY_API_URL || 'https://api.exchangerate-api.com/v4/latest/HUF';

// Runtime maintenance mode state (can be toggled without restart)
let maintenanceMode = process.env.MAINTENANCE_ENABLED === 'true';
const MAINTENANCE_CODE = process.env.MAINTENANCE_CODE || '3550';

// Database helper functions
function saveDb() {
  if (db) {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  }
}

function queryOne(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function runSql(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cors());

// S3-Compatible API Proxy
const { createS3Proxy } = require('./s3-proxy');
const s3ProxyMiddleware = createS3Proxy((accessKey) => {
  return queryOne('SELECT * FROM users WHERE access_key = ?', [accessKey]);
});
app.use(s3ProxyMiddleware);

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// Maintenance mode middleware
app.use((req, res, next) => {
  // Allow maintenance endpoints and admin access
  if (req.path === '/api/system/maintenance' ||
    req.path === '/api/system/maintenance-bypass' ||
    req.path.startsWith('/api/admin/maintenance')) {
    return next();
  }

  // Check for bypass code in session
  if (req.session?.maintenanceBypass) {
    return next();
  }

  // If maintenance mode is on, show maintenance page for HTML requests
  if (maintenanceMode) {
    // Allow API calls from admins
    if (req.session?.userId) {
      const user = queryOne('SELECT is_admin FROM users WHERE id = ?', [req.session.userId]);
      if (user?.is_admin) {
        return next();
      }
    }

    // For API requests, return JSON error
    if (req.path.startsWith('/api/')) {
      return res.status(503).json({ error: 'Maintenance mode', maintenance: true });
    }

    // For page requests, let the SPA handle showing maintenance UI
    if (req.path === '/' || !req.path.includes('.')) {
      res.setHeader('X-Maintenance-Mode', 'true');
    }
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Auth middleware
const requireAuth = (req, res, next) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const user = queryOne('SELECT * FROM users WHERE id = ?', [req.session.userId]);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (user.is_suspended) {
    return res.status(403).json({ error: 'Account suspended', suspended: true });
  }
  req.user = user;
  next();
};

const requireAdmin = (req, res, next) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const user = queryOne('SELECT * FROM users WHERE id = ?', [req.session.userId]);
  if (!user || !user.is_admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  req.user = user;
  next();
};

const requireApiKey = (req, res, next) => {
  const accessKey = req.headers['x-access-key'];
  const secretKey = req.headers['x-secret-key'];

  if (!accessKey || !secretKey) {
    return res.status(401).json({ error: 'API keys required' });
  }

  const user = queryOne('SELECT * FROM users WHERE access_key = ? AND secret_key = ?', [accessKey, secretKey]);
  if (!user) {
    return res.status(401).json({ error: 'Invalid API keys' });
  }
  if (user.is_suspended) {
    return res.status(403).json({ error: 'Account suspended' });
  }
  req.user = user;
  next();
};

// Calculate folder size from S3
async function calculateFolderSize(folderId) {
  try {
    let totalSize = 0;
    let continuationToken = null;

    do {
      const command = new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: `users/${folderId}/`,
        ContinuationToken: continuationToken
      });

      const response = await s3Client.send(command);

      if (response.Contents) {
        for (const obj of response.Contents) {
          totalSize += obj.Size || 0;
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return totalSize;
  } catch (error) {
    console.error('Error calculating folder size:', error);
    return 0;
  }
}

async function updateUserStorageFromS3(userId) {
  const user = queryOne('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) return 0;

  const sizeBytes = await calculateFolderSize(user.folder_id);
  const sizeMb = sizeBytes / (1024 * 1024);

  runSql('UPDATE users SET storage_used_mb = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [sizeMb, userId]);

  return sizeMb;
}

// ==================== AUTH ROUTES ====================

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const existing = queryOne('SELECT * FROM users WHERE email = ?', [email]);
    if (existing) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);
    const userId = uuidv4();
    const folderId = uuidv4().replace(/-/g, '');
    const accessKey = 'AK' + uuidv4().replace(/-/g, '').toUpperCase().substring(0, 20);
    const secretKey = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');

    runSql(`
      INSERT INTO users (id, email, password, folder_id, access_key, secret_key, storage_limit_mb)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `, [userId, email, hashedPassword, folderId, accessKey, secretKey]);

    req.session.userId = userId;

    res.json({ success: true, message: 'Registration successful' });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', (req, res) => {
  try {
    const { email, password } = req.body;

    const user = queryOne('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    req.session.userId = user.id;

    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        is_admin: user.is_admin,
        is_suspended: user.is_suspended
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({
    id: req.user.id,
    email: req.user.email,
    is_admin: req.user.is_admin,
    is_suspended: req.user.is_suspended,
    suspension_reason: req.user.suspension_reason,
    suspension_until: req.user.suspension_until,
    storage_limit_mb: req.user.storage_limit_mb,
    storage_used_mb: req.user.storage_used_mb,
    access_key: req.user.access_key,
    secret_key: req.user.secret_key,
    folder_id: req.user.folder_id
  });
});

app.post('/api/auth/change-password', requireAuth, (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!bcrypt.compareSync(currentPassword, req.user.password)) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    const hashedPassword = bcrypt.hashSync(newPassword, 10);
    runSql('UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [hashedPassword, req.user.id]);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// ==================== USER DASHBOARD ROUTES ====================

app.get('/api/user/storage', requireAuth, async (req, res) => {
  try {
    const usedMb = await updateUserStorageFromS3(req.user.id);
    const user = queryOne('SELECT * FROM users WHERE id = ?', [req.user.id]);

    res.json({
      storage_limit_mb: user.storage_limit_mb,
      storage_used_mb: usedMb,
      storage_limit_exceeded: usedMb >= user.storage_limit_mb && user.storage_limit_mb > 0,
      price_per_gb: PRICE_PER_GB
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get storage info' });
  }
});

app.get('/api/user/credentials', requireAuth, (req, res) => {
  res.json({
    access_key: req.user.access_key,
    secret_key: req.user.secret_key,
    endpoint: `${req.protocol}://${req.get('host')}/s3`,
    bucket: req.user.folder_id
  });
});

// ==================== SYSTEM ROUTES ====================

// Get maintenance mode status
app.get('/api/system/maintenance', (req, res) => {
  res.json({ maintenance: maintenanceMode });
});

// Bypass maintenance mode with code
app.post('/api/system/maintenance-bypass', (req, res) => {
  const { code } = req.body;
  if (code === MAINTENANCE_CODE) {
    req.session.maintenanceBypass = true;
    res.json({ success: true });
  } else {
    res.status(403).json({ error: 'Invalid code' });
  }
});

// Get currency exchange rates
app.get('/api/system/exchange-rates', async (req, res) => {
  try {
    const response = await fetch(CURRENCY_API_URL);
    const data = await response.json();

    res.json({
      base: 'HUF',
      rates: {
        HUF: 1,
        EUR: data.rates?.EUR || 0.0025,
        USD: data.rates?.USD || 0.0027
      },
      prices: {
        HUF: PRICE_PER_GB,
        EUR: PRICE_PER_GB_EUR,
        USD: PRICE_PER_GB_USD
      },
      limits: {
        min_gb: MIN_PURCHASE_GB,
        max_gb: MAX_PURCHASE_GB
      }
    });
  } catch (error) {
    // Fallback to static rates if API fails
    res.json({
      base: 'HUF',
      rates: { HUF: 1, EUR: 0.0025, USD: 0.0027 },
      prices: { HUF: PRICE_PER_GB, EUR: PRICE_PER_GB_EUR, USD: PRICE_PER_GB_USD },
      limits: { min_gb: MIN_PURCHASE_GB, max_gb: MAX_PURCHASE_GB }
    });
  }
});

// Pre-check file size before upload
app.post('/api/files/check-size', requireAuth, async (req, res) => {
  try {
    const { file_size_bytes, file_name } = req.body;

    if (!file_size_bytes) {
      return res.status(400).json({ error: 'File size required' });
    }

    const usedMb = await updateUserStorageFromS3(req.user.id);
    const user = queryOne('SELECT * FROM users WHERE id = ?', [req.user.id]);
    const fileSizeMb = file_size_bytes / (1024 * 1024);
    const newTotalMb = usedMb + fileSizeMb;

    // Check if it would exceed storage limit
    const wouldExceed = user.storage_limit_mb > 0 && newTotalMb > user.storage_limit_mb;
    const availableMb = user.storage_limit_mb - usedMb;

    res.json({
      allowed: !wouldExceed,
      file_size_mb: fileSizeMb,
      storage_used_mb: usedMb,
      storage_limit_mb: user.storage_limit_mb,
      storage_available_mb: Math.max(0, availableMb),
      would_exceed: wouldExceed
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to check file size' });
  }
});

// ==================== PAYMENT ROUTES ====================

app.post('/api/payment/create', requireAuth, async (req, res) => {
  try {
    const { storage_gb } = req.body;

    if (!storage_gb || storage_gb < 1) {
      return res.status(400).json({ error: 'Invalid storage amount' });
    }

    const amountHuf = storage_gb * PRICE_PER_GB;
    const storageMb = storage_gb * 1024;
    const paymentId = uuidv4();

    runSql(`
      INSERT INTO payments (id, user_id, amount_huf, storage_mb, status)
      VALUES (?, ?, ?, ?, 'pending')
    `, [paymentId, req.user.id, amountHuf, storageMb]);

    const paypalEmail = process.env.PAYPAL_EMAIL || 'web@geri-888.hu';
    const returnUrl = `${req.protocol}://${req.get('host')}/api/payment/success?payment_id=${paymentId}`;
    const cancelUrl = `${req.protocol}://${req.get('host')}/api/payment/cancel?payment_id=${paymentId}`;
    const ipnUrl = `${req.protocol}://${req.get('host')}/api/payment/ipn`;

    const paypalUrl = `https://www.paypal.com/cgi-bin/webscr?cmd=_xclick` +
      `&business=${encodeURIComponent(paypalEmail)}` +
      `&item_name=${encodeURIComponent(`S3 Tárhely - ${storage_gb} GB`)}` +
      `&amount=${amountHuf}` +
      `&currency_code=HUF` +
      `&custom=${paymentId}` +
      `&return=${encodeURIComponent(returnUrl)}` +
      `&cancel_return=${encodeURIComponent(cancelUrl)}` +
      `&notify_url=${encodeURIComponent(ipnUrl)}` +
      `&no_shipping=1`;

    res.json({
      payment_id: paymentId,
      amount_huf: amountHuf,
      storage_gb: storage_gb,
      paypal_url: paypalUrl
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create payment' });
  }
});

app.post('/api/payment/complete', requireAuth, async (req, res) => {
  try {
    const { payment_id, paypal_order_id, payer_email } = req.body;

    const payment = queryOne('SELECT * FROM payments WHERE id = ? AND user_id = ?', [payment_id, req.user.id]);
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    runSql(`UPDATE payments SET status = 'completed', paypal_order_id = ?, paypal_payer_email = ? WHERE id = ?`,
      [paypal_order_id, payer_email, payment_id]);

    const newLimit = req.user.storage_limit_mb + payment.storage_mb;
    runSql('UPDATE users SET storage_limit_mb = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [newLimit, req.user.id]);

    res.json({ success: true, new_storage_limit_mb: newLimit });
  } catch (error) {
    res.status(500).json({ error: 'Failed to complete payment' });
  }
});

// PayPal success redirect - user returns here after payment
app.get('/api/payment/success', (req, res) => {
  const { payment_id } = req.query;
  // Show success page - IPN will handle the actual credit
  res.send(`
    <!DOCTYPE html>
    <html lang="hu">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Fizetés sikeres</title>
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-gray-900 min-h-screen flex items-center justify-center">
      <div class="bg-gray-800 rounded-2xl p-8 max-w-md text-center text-white">
        <div class="text-6xl mb-4">✅</div>
        <h1 class="text-2xl font-bold mb-4">Fizetés sikeres!</h1>
        <p class="text-gray-400 mb-6">A tárhely hamarosan jóváírásra kerül a fiókodban. Ez általában néhány percet vesz igénybe.</p>
        <a href="/" class="inline-block bg-indigo-600 hover:bg-indigo-700 px-6 py-3 rounded-lg font-semibold">Vissza a főoldalra</a>
      </div>
    </body>
    </html>
  `);
});

// PayPal cancel redirect
app.get('/api/payment/cancel', (req, res) => {
  const { payment_id } = req.query;
  if (payment_id) {
    runSql(`UPDATE payments SET status = 'cancelled' WHERE id = ?`, [payment_id]);
  }
  res.send(`
    <!DOCTYPE html>
    <html lang="hu">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Fizetés megszakítva</title>
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-gray-900 min-h-screen flex items-center justify-center">
      <div class="bg-gray-800 rounded-2xl p-8 max-w-md text-center text-white">
        <div class="text-6xl mb-4">❌</div>
        <h1 class="text-2xl font-bold mb-4">Fizetés megszakítva</h1>
        <p class="text-gray-400 mb-6">A fizetés nem történt meg. Próbáld újra, ha szeretnél tárhelyet vásárolni.</p>
        <a href="/" class="inline-block bg-indigo-600 hover:bg-indigo-700 px-6 py-3 rounded-lg font-semibold">Vissza a főoldalra</a>
      </div>
    </body>
    </html>
  `);
});

// PayPal IPN endpoint - this is called by PayPal when payment is completed
app.post('/api/payment/ipn', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    console.log('IPN received:', req.body);

    // Step 1: Send verification request back to PayPal
    const verifyBody = 'cmd=_notify-validate&' + new URLSearchParams(req.body).toString();

    const verifyResponse = await fetch('https://www.paypal.com/cgi-bin/webscr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: verifyBody
    });

    const verifyResult = await verifyResponse.text();
    console.log('PayPal verification result:', verifyResult);

    // Step 2: Only process if PayPal confirms it's VERIFIED
    if (verifyResult !== 'VERIFIED') {
      console.log('IPN verification failed - possible fraud attempt');
      return res.status(200).send('OK');
    }

    const { payment_status, custom, mc_gross, payer_email, receiver_email, mc_currency } = req.body;

    // Step 3: Verify receiver email matches our PayPal email
    const expectedEmail = process.env.PAYPAL_EMAIL;
    if (receiver_email && receiver_email.toLowerCase() !== expectedEmail.toLowerCase()) {
      console.log('IPN receiver email mismatch:', receiver_email, 'expected:', expectedEmail);
      return res.status(200).send('OK');
    }

    // Step 4: Process the payment
    if (payment_status === 'Completed' && custom) {
      const payment = queryOne('SELECT * FROM payments WHERE id = ?', [custom]);

      if (payment && payment.status === 'pending') {
        // Verify amount matches
        const expectedAmount = payment.amount_huf;
        const receivedAmount = parseFloat(mc_gross);

        if (Math.abs(receivedAmount - expectedAmount) > 1) {
          console.log('IPN amount mismatch:', receivedAmount, 'expected:', expectedAmount);
          return res.status(200).send('OK');
        }

        // All checks passed - credit the storage
        runSql(`UPDATE payments SET status = 'completed', paypal_payer_email = ? WHERE id = ?`, [payer_email, custom]);

        const user = queryOne('SELECT * FROM users WHERE id = ?', [payment.user_id]);
        if (user) {
          const newLimit = user.storage_limit_mb + payment.storage_mb;
          runSql('UPDATE users SET storage_limit_mb = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [newLimit, user.id]);
          console.log('Storage credited:', user.email, '+', payment.storage_mb, 'MB');
        }
      }
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('IPN error:', error);
    res.status(200).send('OK');
  }
});

app.get('/api/user/payments', requireAuth, (req, res) => {
  const payments = queryAll('SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
  res.json(payments);
});

// ==================== S3 PROXY ROUTES ====================

const checkStorageLimit = async (req, res, next) => {
  const user = req.user;
  const usedMb = await updateUserStorageFromS3(user.id);
  const currentUser = queryOne('SELECT * FROM users WHERE id = ?', [user.id]);

  if (usedMb >= currentUser.storage_limit_mb && currentUser.storage_limit_mb > 0) {
    return res.status(403).json({
      error: 'Storage limit exceeded',
      storage_used_mb: usedMb,
      storage_limit_mb: currentUser.storage_limit_mb
    });
  }

  req.storageUsedMb = usedMb;
  req.user = currentUser;
  next();
};

app.get('/s3/list', requireApiKey, async (req, res) => {
  try {
    const prefix = req.query.prefix || '';
    const userPrefix = `users/${req.user.folder_id}/${prefix}`;

    const command = new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: userPrefix,
      Delimiter: '/'
    });

    const response = await s3Client.send(command);

    const files = (response.Contents || []).map(obj => ({
      key: obj.Key.replace(`users/${req.user.folder_id}/`, ''),
      size: obj.Size,
      last_modified: obj.LastModified
    }));

    const folders = (response.CommonPrefixes || []).map(p => ({
      prefix: p.Prefix.replace(`users/${req.user.folder_id}/`, '')
    }));

    res.json({ files, folders });
  } catch (error) {
    console.error('List error:', error);
    res.status(500).json({ error: 'Failed to list files' });
  }
});

app.post('/s3/upload', requireApiKey, checkStorageLimit, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const filePath = req.body.path || req.file.originalname;
    const key = `users/${req.user.folder_id}/${filePath}`;

    const newSizeMb = req.storageUsedMb + (req.file.size / (1024 * 1024));
    if (newSizeMb > req.user.storage_limit_mb && req.user.storage_limit_mb > 0) {
      return res.status(403).json({
        error: 'Upload would exceed storage limit',
        storage_used_mb: req.storageUsedMb,
        storage_limit_mb: req.user.storage_limit_mb,
        file_size_mb: req.file.size / (1024 * 1024)
      });
    }

    const command = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype
    });

    await s3Client.send(command);

    runSql(`INSERT INTO storage_logs (id, user_id, action, file_path, file_size_bytes) VALUES (?, ?, 'upload', ?, ?)`,
      [uuidv4(), req.user.id, filePath, req.file.size]);

    res.json({ success: true, key: filePath });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

app.get('/s3/download', requireApiKey, async (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) {
      return res.status(400).json({ error: 'Path required' });
    }

    const key = `users/${req.user.folder_id}/${filePath}`;

    const command = new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: key
    });

    const response = await s3Client.send(command);

    res.setHeader('Content-Type', response.ContentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);

    response.Body.pipe(res);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: 'Failed to download file' });
  }
});

app.delete('/s3/delete', requireApiKey, async (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) {
      return res.status(400).json({ error: 'Path required' });
    }

    const key = `users/${req.user.folder_id}/${filePath}`;

    const command = new DeleteObjectCommand({
      Bucket: S3_BUCKET,
      Key: key
    });

    await s3Client.send(command);

    runSql(`INSERT INTO storage_logs (id, user_id, action, file_path) VALUES (?, ?, 'delete', ?)`,
      [uuidv4(), req.user.id, filePath]);

    res.json({ success: true });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

app.post('/s3/presign-upload', requireApiKey, checkStorageLimit, async (req, res) => {
  try {
    const { path: filePath, content_type } = req.body;
    if (!filePath) {
      return res.status(400).json({ error: 'Path required' });
    }

    const key = `users/${req.user.folder_id}/${filePath}`;

    const command = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      ContentType: content_type || 'application/octet-stream'
    });

    const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

    res.json({ url, key: filePath });
  } catch (error) {
    console.error('Presign error:', error);
    res.status(500).json({ error: 'Failed to generate presigned URL' });
  }
});

app.get('/s3/presign-download', requireApiKey, async (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) {
      return res.status(400).json({ error: 'Path required' });
    }

    const key = `users/${req.user.folder_id}/${filePath}`;

    const command = new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: key
    });

    const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

    res.json({ url });
  } catch (error) {
    console.error('Presign error:', error);
    res.status(500).json({ error: 'Failed to generate presigned URL' });
  }
});

// ==================== WEB FILE MANAGER ROUTES ====================

app.get('/api/files/list', requireAuth, async (req, res) => {
  try {
    const prefix = req.query.prefix || '';
    const userPrefix = `users/${req.user.folder_id}/${prefix}`;

    const command = new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: userPrefix,
      Delimiter: '/'
    });

    const response = await s3Client.send(command);

    const files = (response.Contents || [])
      .filter(obj => obj.Key !== userPrefix)
      .map(obj => ({
        key: obj.Key.replace(`users/${req.user.folder_id}/`, ''),
        name: path.basename(obj.Key),
        size: obj.Size,
        last_modified: obj.LastModified,
        type: 'file'
      }));

    const folders = (response.CommonPrefixes || []).map(p => ({
      key: p.Prefix.replace(`users/${req.user.folder_id}/`, ''),
      name: path.basename(p.Prefix.slice(0, -1)),
      type: 'folder'
    }));

    res.json({ files, folders, current_prefix: prefix });
  } catch (error) {
    console.error('List error:', error);
    res.status(500).json({ error: 'Failed to list files' });
  }
});

app.post('/api/files/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const usedMb = await updateUserStorageFromS3(req.user.id);
    const user = queryOne('SELECT * FROM users WHERE id = ?', [req.user.id]);

    if (usedMb >= user.storage_limit_mb && user.storage_limit_mb > 0) {
      return res.status(403).json({ error: 'Storage limit exceeded' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const prefix = req.body.prefix || '';
    const filePath = prefix + req.file.originalname;
    const key = `users/${req.user.folder_id}/${filePath}`;

    const newSizeMb = usedMb + (req.file.size / (1024 * 1024));
    if (newSizeMb > user.storage_limit_mb && user.storage_limit_mb > 0) {
      return res.status(403).json({ error: 'Upload would exceed storage limit' });
    }

    // Malicious content detection
    const fileName = req.file.originalname.toLowerCase();
    let fileContent = '';

    // Only check text-based files for content
    const textMimeTypes = ['text/', 'application/json', 'application/javascript', 'application/xml'];
    if (textMimeTypes.some(t => req.file.mimetype.startsWith(t))) {
      fileContent = req.file.buffer.toString('utf8').toLowerCase();
    }

    let isMalicious = false;
    let detectedPattern = null;

    for (const pattern of MALICIOUS_PATTERNS) {
      if (pattern.test(fileName) || pattern.test(fileContent)) {
        isMalicious = true;
        detectedPattern = pattern.source;
        break;
      }
    }

    if (isMalicious) {
      // Auto-suspend user and log the incident
      runSql(`UPDATE users SET is_suspended = 1, suspension_reason = ?, suspension_until = NULL, 
              malicious_detected = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [`Kártékony fájl észlelve: "${req.file.originalname}" (minta: ${detectedPattern})`, req.user.id]);

      return res.status(403).json({
        error: 'Malicious content detected',
        malicious: true,
        file_name: req.file.originalname,
        pattern: detectedPattern
      });
    }

    const command = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype
    });

    await s3Client.send(command);

    res.json({ success: true, key: filePath });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

app.get('/api/files/download', requireAuth, async (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) {
      return res.status(400).json({ error: 'Path required' });
    }

    const key = `users/${req.user.folder_id}/${filePath}`;

    const command = new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: key
    });

    const response = await s3Client.send(command);

    res.setHeader('Content-Type', response.ContentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);

    response.Body.pipe(res);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: 'Failed to download file' });
  }
});

app.delete('/api/files/delete', requireAuth, async (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) {
      return res.status(400).json({ error: 'Path required' });
    }

    const key = `users/${req.user.folder_id}/${filePath}`;

    const command = new DeleteObjectCommand({
      Bucket: S3_BUCKET,
      Key: key
    });

    await s3Client.send(command);

    res.json({ success: true });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

app.post('/api/files/create-folder', requireAuth, async (req, res) => {
  try {
    const { prefix, name } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Folder name required' });
    }

    const folderPath = (prefix || '') + name + '/';
    const key = `users/${req.user.folder_id}/${folderPath}`;

    const command = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: ''
    });

    await s3Client.send(command);

    res.json({ success: true, key: folderPath });
  } catch (error) {
    console.error('Create folder error:', error);
    res.status(500).json({ error: 'Failed to create folder' });
  }
});

// ==================== ADMIN ROUTES ====================

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const users = queryAll(`
      SELECT id, email, is_admin, is_suspended, suspension_reason, suspension_until, malicious_detected,
             folder_id, access_key, storage_limit_mb, storage_used_mb, created_at, updated_at
      FROM users ORDER BY created_at DESC
    `);

    for (const user of users) {
      user.storage_used_mb = await updateUserStorageFromS3(user.id);
    }

    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get users' });
  }
});

app.get('/api/admin/user/:id', requireAdmin, async (req, res) => {
  try {
    const user = queryOne(`
      SELECT id, email, is_admin, is_suspended, folder_id, access_key, secret_key,
             storage_limit_mb, storage_used_mb, created_at, updated_at
      FROM users WHERE id = ?
    `, [req.params.id]);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    user.storage_used_mb = await updateUserStorageFromS3(user.id);

    const payments = queryAll('SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC', [req.params.id]);

    res.json({ user, payments });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get user' });
  }
});

app.post('/api/admin/user/:id/suspend', requireAdmin, (req, res) => {
  try {
    const { reason, duration_hours } = req.body;
    let suspendUntil = null;

    if (duration_hours && duration_hours > 0) {
      suspendUntil = new Date(Date.now() + duration_hours * 60 * 60 * 1000).toISOString();
    }

    runSql(`UPDATE users SET is_suspended = 1, suspension_reason = ?, suspension_until = ?, 
            updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [reason || 'Admin által felfüggesztve', suspendUntil, req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to suspend user' });
  }
});

app.post('/api/admin/user/:id/unsuspend', requireAdmin, (req, res) => {
  try {
    runSql(`UPDATE users SET is_suspended = 0, suspension_reason = NULL, suspension_until = NULL, 
            malicious_detected = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to unsuspend user' });
  }
});

app.delete('/api/admin/user/:id', requireAdmin, async (req, res) => {
  try {
    const user = queryOne('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.is_admin) {
      return res.status(400).json({ error: 'Cannot delete admin user' });
    }

    let continuationToken = null;
    do {
      const listCommand = new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: `users/${user.folder_id}/`,
        ContinuationToken: continuationToken
      });

      const response = await s3Client.send(listCommand);

      if (response.Contents) {
        for (const obj of response.Contents) {
          const deleteCommand = new DeleteObjectCommand({
            Bucket: S3_BUCKET,
            Key: obj.Key
          });
          await s3Client.send(deleteCommand);
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    runSql('DELETE FROM storage_logs WHERE user_id = ?', [req.params.id]);
    runSql('DELETE FROM payments WHERE user_id = ?', [req.params.id]);
    runSql('DELETE FROM users WHERE id = ?', [req.params.id]);

    res.json({ success: true });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

app.post('/api/admin/user/:id/update-email', requireAdmin, (req, res) => {
  try {
    const { email } = req.body;
    runSql('UPDATE users SET email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [email, req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update email' });
  }
});

app.post('/api/admin/user/:id/update-storage', requireAdmin, (req, res) => {
  try {
    const { storage_limit_mb } = req.body;
    runSql('UPDATE users SET storage_limit_mb = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [storage_limit_mb, req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update storage limit' });
  }
});

app.get('/api/admin/payments', requireAdmin, (req, res) => {
  try {
    const payments = queryAll(`
      SELECT p.*, u.email as user_email
      FROM payments p
      JOIN users u ON p.user_id = u.id
      ORDER BY p.created_at DESC
    `);
    res.json(payments);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get payments' });
  }
});

// Admin: List user files
app.get('/api/admin/user/:id/files', requireAdmin, async (req, res) => {
  try {
    const user = queryOne('SELECT folder_id FROM users WHERE id = ?', [req.params.id]);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const prefix = req.query.prefix || '';
    const userPrefix = `users/${user.folder_id}/${prefix}`;

    const command = new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: userPrefix,
      Delimiter: '/'
    });

    const response = await s3Client.send(command);

    const files = (response.Contents || [])
      .filter(obj => obj.Key !== userPrefix)
      .map(obj => ({
        key: obj.Key.replace(`users/${user.folder_id}/`, ''),
        name: path.basename(obj.Key),
        size: obj.Size,
        last_modified: obj.LastModified,
        type: 'file'
      }));

    const folders = (response.CommonPrefixes || []).map(p => ({
      key: p.Prefix.replace(`users/${user.folder_id}/`, ''),
      name: path.basename(p.Prefix.slice(0, -1)),
      type: 'folder'
    }));

    res.json({ files, folders, current_prefix: prefix });
  } catch (error) {
    console.error('Admin list files error:', error);
    res.status(500).json({ error: 'Failed to list user files' });
  }
});

// Admin: Download user file
app.get('/api/admin/user/:id/files/download', requireAdmin, async (req, res) => {
  try {
    const user = queryOne('SELECT folder_id FROM users WHERE id = ?', [req.params.id]);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const filePath = req.query.path;
    if (!filePath) {
      return res.status(400).json({ error: 'Path required' });
    }

    const key = `users/${user.folder_id}/${filePath}`;

    const command = new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: key
    });

    const response = await s3Client.send(command);

    res.setHeader('Content-Type', response.ContentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);

    response.Body.pipe(res);
  } catch (error) {
    console.error('Admin download error:', error);
    res.status(500).json({ error: 'Failed to download file' });
  }
});

// Admin: manually approve a pending payment
app.post('/api/admin/payment/:id/approve', requireAdmin, async (req, res) => {
  try {
    const payment = queryOne('SELECT * FROM payments WHERE id = ?', [req.params.id]);

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    if (payment.status === 'completed') {
      return res.status(400).json({ error: 'Payment already completed' });
    }

    // Mark payment as completed
    runSql(`UPDATE payments SET status = 'completed' WHERE id = ?`, [payment.id]);

    // Credit the storage
    const user = queryOne('SELECT * FROM users WHERE id = ?', [payment.user_id]);
    if (user) {
      const newLimit = user.storage_limit_mb + payment.storage_mb;
      runSql('UPDATE users SET storage_limit_mb = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [newLimit, user.id]);
    }

    res.json({ success: true, message: 'Payment approved and storage credited' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to approve payment' });
  }
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const totalUsers = queryOne('SELECT COUNT(*) as count FROM users WHERE is_admin = 0')?.count || 0;
    const suspendedUsers = queryOne('SELECT COUNT(*) as count FROM users WHERE is_suspended = 1')?.count || 0;
    const maliciousUsers = queryOne('SELECT COUNT(*) as count FROM users WHERE malicious_detected = 1')?.count || 0;
    const totalPayments = queryOne('SELECT COUNT(*) as count FROM payments WHERE status = "completed"')?.count || 0;
    const totalRevenue = queryOne('SELECT SUM(amount_huf) as total FROM payments WHERE status = "completed"')?.total || 0;
    const totalStorageMb = queryOne('SELECT SUM(storage_limit_mb) as total FROM users')?.total || 0;
    const usedStorageMb = queryOne('SELECT SUM(storage_used_mb) as total FROM users')?.total || 0;

    res.json({
      total_users: totalUsers,
      suspended_users: suspendedUsers,
      malicious_users: maliciousUsers,
      total_payments: totalPayments,
      total_revenue_huf: totalRevenue,
      total_storage_gb: (totalStorageMb / 1024).toFixed(2),
      used_storage_gb: (usedStorageMb / 1024).toFixed(2),
      maintenance_mode: maintenanceMode
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// Admin maintenance mode toggle
app.get('/api/admin/maintenance', requireAdmin, (req, res) => {
  res.json({ maintenance: maintenanceMode });
});

app.post('/api/admin/maintenance', requireAdmin, (req, res) => {
  const { enabled } = req.body;
  maintenanceMode = !!enabled;
  res.json({ success: true, maintenance: maintenanceMode });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Initialize database and start server
async function startServer() {
  try {
    const SQL = await initSqlJs();

    if (fs.existsSync(DB_PATH)) {
      const buffer = fs.readFileSync(DB_PATH);
      db = new SQL.Database(buffer);
    } else {
      console.log('Database not found. Please run: npm run init-db');
      process.exit(1);
    }

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
