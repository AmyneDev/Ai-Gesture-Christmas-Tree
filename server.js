const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const morgan = require('morgan');

const app = express();
const PORT = process.env.PORT || 3000;

const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const UPLOADS_DIR = path.join(ROOT_DIR, 'uploads');
const PHOTO_DIR = path.join(UPLOADS_DIR, 'photos');
const DB_FILE = path.join(DATA_DIR, 'users.json');

fs.mkdirSync(PHOTO_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

function loadDb() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { byUsername: {}, byShortId: {} };
  }
}

function saveDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

function generateShortId() {
  return Math.random().toString(36).slice(2, 8);
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const username = String(req.params.username || '').trim().toLowerCase();
    const userDir = path.join(PHOTO_DIR, username || 'anonymous');
    fs.mkdirSync(userDir, { recursive: true });
    cb(null, userDir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname) || '.jpg';
    const base = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, base + ext);
  }
});

const upload = multer({
  storage,
  fileFilter(req, file, cb) {
    if (file.mimetype && file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image uploads are allowed'));
    }
  }
});

app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(ROOT_DIR));

app.get('/api/user/:username', (req, res) => {
  const username = String(req.params.username || '').trim().toLowerCase();
  const db = loadDb();
  const user = db.byUsername[username];
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json({
    username,
    blessing: user.blessing || '',
    photos: user.photos || [],
    shortId: user.shortId || null
  });
});

app.post('/api/config/:username', upload.array('photos', 20), (req, res) => {
  const usernameRaw = String(req.params.username || '').trim();
  const username = usernameRaw.toLowerCase();
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }

  const blessing = String(req.body.blessing || '').trim();
  const db = loadDb();
  const existing = db.byUsername[username] || {};

  const photos = Array.isArray(existing.photos) ? [...existing.photos] : [];

  if (Array.isArray(req.files)) {
    req.files.forEach((file) => {
      const relPath = path.relative(ROOT_DIR, file.path).split(path.sep).join('/');
      const urlPath = '/' + relPath;
      photos.push(urlPath);
    });
  }

  let shortId = existing.shortId;
  if (!shortId) {
    const byShortId = db.byShortId;
    do {
      shortId = generateShortId();
    } while (byShortId[shortId]);
  }

  db.byUsername[username] = {
    username,
    blessing,
    photos,
    shortId
  };
  db.byShortId[shortId] = username;
  saveDb(db);

  const shortUrl = `/u/${shortId}`;
  res.json({
    ok: true,
    username,
    blessing,
    photos,
    shortId,
    shortUrl
  });
});

app.post('/api/delete-photo/:username', (req, res) => {
  console.log('Delete photo request received');
  console.log('Username:', req.params.username);
  console.log('Request body:', req.body);

  const username = String(req.params.username || '').trim().toLowerCase();
  if (!username) {
    console.log('Error: Username is required');
    return res.status(400).json({ ok: false, error: 'Username is required' });
  }

  const { photoUrl } = req.body;
  if (!photoUrl) {
    console.log('Error: Photo URL is required');
    return res.status(400).json({ ok: false, error: 'Photo URL is required' });
  }

  console.log('Photo URL to delete:', photoUrl);

  const db = loadDb();
  const user = db.byUsername[username];
  if (!user) {
    console.log('Error: User not found');
    return res.status(404).json({ ok: false, error: 'User not found' });
  }

  if (!Array.isArray(user.photos)) {
    console.log('Error: No photos array found');
    return res.status(400).json({ ok: false, error: 'No photos found' });
  }

  console.log('Current photos:', user.photos);
  const photoIndex = user.photos.indexOf(photoUrl);
  if (photoIndex === -1) {
    console.log('Error: Photo not found in user data');
    return res.status(404).json({ ok: false, error: 'Photo not found in user data' });
  }

  // 从数据库中移除照片URL
  user.photos.splice(photoIndex, 1);
  saveDb(db);
  console.log('Photo removed from database. Remaining photos:', user.photos);

  // 尝试删除文件系统中的文件
  try {
    // 处理 URL 路径，移除开头的斜杠
    let cleanPath = photoUrl.startsWith('/') ? photoUrl.substring(1) : photoUrl;
    const filePath = path.join(ROOT_DIR, cleanPath);
    console.log('Attempting to delete file:', filePath);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log('File deleted successfully');
    } else {
      console.log('File not found on disk, but removed from database');
    }
  } catch (err) {
    console.error('Failed to delete file:', err);
    // 即使文件删除失败，也返回成功，因为数据库已更新
  }

  console.log('Delete operation completed successfully');
  res.json({ ok: true, message: 'Photo deleted successfully' });
});

app.get('/u/:shortId', (req, res) => {
  const shortId = String(req.params.shortId || '').trim();
  const db = loadDb();
  const username = db.byShortId[shortId];
  if (!username) {
    return res.status(404).send('Invalid link');
  }
  const encoded = encodeURIComponent(username);
  res.redirect(`/tree.html?user=${encoded}`);
});

// 全局错误处理（包括上传非图片文件时的错误）
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err.message === 'Only image uploads are allowed') {
    return res.status(400).json({ error: 'Only image uploads are allowed' });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
