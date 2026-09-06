const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');
const { fetchWpPost, parseContentBlocks, downloadImage, parseDateFromTitle } = require('./lib/wordpress-import');

const app = express();
// Use Railway's provided port if available, otherwise fall back to 8000 locally
const PORT = process.env.PORT || 8000;

// --- Data directory setup ---
// Set DATA_DIR to a mounted volume path in production so data survives redeploys.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const BLOGS_DIR = path.join(DATA_DIR, 'blogs');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const AVATARS_DIR = path.join(DATA_DIR, 'avatars');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

ensureDir(DATA_DIR);
ensureDir(BLOGS_DIR);
ensureDir(SESSIONS_DIR);
ensureDir(AVATARS_DIR);
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '{}');

// --- Helpers ---
function readUsers() {
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}

function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function userBlogsDir(username) {
  return path.join(BLOGS_DIR, username);
}

function blogDir(username, blogId) {
  return path.join(userBlogsDir(username), blogId);
}

function postDir(username, blogId, postId) {
  return path.join(blogDir(username, blogId), 'posts', postId);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function countPhotos(content) {
  let count = 0;
  for (const block of content) {
    if (block.type === 'image') count++;
    else if (block.type === 'table') {
      for (const row of block.rows) {
        for (const cell of row) {
          if (cell && cell.type === 'image') count++;
        }
      }
    }
  }
  return count;
}

function dirSize(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function spliceBlock(content, block, insertAt) {
  const pos = parseInt(insertAt);
  if (!isNaN(pos) && pos >= 0 && pos <= content.length) content.splice(pos, 0, block);
  else content.push(block);
}

// --- Middleware ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/data/blogs', (req, res, next) => {
  // Only serve image files from blog directories
  if (/\.(jpg|jpeg|png|gif|webp)$/i.test(req.path)) return next();
  res.status(403).send('Forbidden');
}, express.static(BLOGS_DIR));
app.use('/data/avatars', express.static(AVATARS_DIR));

app.use(session({
  store: new FileStore({ path: SESSIONS_DIR }),
  secret: process.env.SESSION_SECRET || 'blog-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

function requireAuth(req, res, next) {
  if (!req.session.username) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

// --- Multer for image uploads ---
const storage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(postDir(req.session.username, req.params.blogId, req.params.postId), 'images');
    ensureDir(dir);
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (/^image\//i.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only images allowed'));
  }
});

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (/^image\//i.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only images allowed'));
  }
});

// --- Auth routes ---
app.post('/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) return res.status(400).json({ error: 'Invalid username' });

  const users = readUsers();
  if (users[username]) return res.status(409).json({ error: 'Username taken' });

  const hash = await bcrypt.hash(password, 12);
  users[username] = { passwordHash: hash, createdAt: new Date().toISOString() };
  writeUsers(users);
  ensureDir(userBlogsDir(username));

  req.session.username = username;
  res.json({ username });
});

app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const users = readUsers();
  const user = users[username];
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  req.session.username = username;
  res.json({ username });
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/auth/me', (req, res) => {
  if (req.session.username) res.json({ username: req.session.username });
  else res.status(401).json({ error: 'Not authenticated' });
});

// --- Account routes ---
app.put('/api/account/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password required' });

  const users = readUsers();
  const user = users[req.session.username];
  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });

  user.passwordHash = await bcrypt.hash(newPassword, 12);
  writeUsers(users);
  res.json({ ok: true });
});

app.post('/api/account/avatar', requireAuth, avatarUpload.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Photo required' });
  try {
    const buffer = await sharp(req.file.buffer)
      .resize({ width: 256, height: 256, fit: 'cover' })
      .jpeg({ quality: 85 })
      .toBuffer();
    fs.writeFileSync(path.join(AVATARS_DIR, `${req.session.username}.jpg`), buffer);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to process image' });
  }
});

// --- Blog routes ---
app.get('/api/blogs', requireAuth, (req, res) => {
  const dir = userBlogsDir(req.session.username);
  if (!fs.existsSync(dir)) return res.json([]);

  const blogs = fs.readdirSync(dir)
    .filter(id => fs.existsSync(path.join(dir, id, 'meta.json')))
    .map(id => ({ id, ...readJson(path.join(dir, id, 'meta.json')) }));

  blogs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(blogs);
});

app.post('/api/blogs', requireAuth, (req, res) => {
  const { name, purpose } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });

  const id = slugify(name) + '-' + Date.now();
  const dir = blogDir(req.session.username, id);
  ensureDir(path.join(dir, 'posts'));

  const meta = { name, purpose: purpose || '', createdAt: new Date().toISOString() };
  writeJson(path.join(dir, 'meta.json'), meta);

  res.status(201).json({ id, ...meta });
});

app.patch('/api/blogs/:blogId', requireAuth, (req, res) => {
  const dir = blogDir(req.session.username, req.params.blogId);
  const metaFile = path.join(dir, 'meta.json');
  if (!fs.existsSync(metaFile)) return res.status(404).json({ error: 'Blog not found' });

  const meta = readJson(metaFile);
  if (req.body.name !== undefined) meta.name = req.body.name;
  if (req.body.purpose !== undefined) meta.purpose = req.body.purpose;
  writeJson(metaFile, meta);

  res.json({ id: req.params.blogId, ...meta });
});

// --- Post routes ---
app.get('/api/blogs/:blogId/posts', requireAuth, (req, res) => {
  const postsDir = path.join(blogDir(req.session.username, req.params.blogId), 'posts');
  if (!fs.existsSync(postsDir)) return res.json([]);

  const posts = fs.readdirSync(postsDir)
    .filter(id => fs.existsSync(path.join(postsDir, id, 'meta.json')))
    .map(id => {
      const contentFile = path.join(postsDir, id, 'content.json');
      const photoCount = fs.existsSync(contentFile) ? countPhotos(readJson(contentFile)) : 0;
      return { id, ...readJson(path.join(postsDir, id, 'meta.json')), size: dirSize(path.join(postsDir, id)), photoCount };
    });

  posts.sort((a, b) => new Date(b.hikeDate || b.createdAt) - new Date(a.hikeDate || a.createdAt));
  res.json(posts);
});

app.post('/api/blogs/:blogId/posts', requireAuth, (req, res) => {
  const { title, hikeDate } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });

  const id = uuidv4();
  const dir = postDir(req.session.username, req.params.blogId, id);
  ensureDir(path.join(dir, 'images'));

  const meta = { title, createdAt: new Date().toISOString() };
  if (hikeDate) meta.hikeDate = hikeDate;
  writeJson(path.join(dir, 'meta.json'), meta);
  writeJson(path.join(dir, 'content.json'), []);

  res.status(201).json({ id, ...meta });
});

// Import a WordPress.com post: fetch it, map its content into blocks, and create the post.
app.post('/api/blogs/:blogId/posts/import-wordpress', requireAuth, async (req, res) => {
  const { url, title: titleOverride, hikeDate: hikeDateOverride } = req.body;
  if (!url) return res.status(400).json({ error: 'WordPress URL required' });

  let wpPost;
  try {
    wpPost = await fetchWpPost(url);
  } catch (err) {
    return res.status(400).json({ error: `Failed to fetch WordPress post: ${err.message}` });
  }

  const title = titleOverride || wpPost.title;
  const hikeDate = hikeDateOverride || parseDateFromTitle(title) || wpPost.date.slice(0, 10);

  const id = uuidv4();
  const dir = postDir(req.session.username, req.params.blogId, id);
  const imagesDir = path.join(dir, 'images');
  ensureDir(imagesDir);

  const baseUrl = `/data/blogs/${req.session.username}/${req.params.blogId}/posts/${id}/images/`;
  async function saveDownloadedImage(src) {
    const { buffer, filename } = await downloadImage(src);
    const savedName = uuidv4() + (path.extname(filename) || '.jpg');
    fs.writeFileSync(path.join(imagesDir, savedName), buffer);
    return { filename: savedName, url: baseUrl + savedName };
  }

  const content = [];
  try {
    for (const block of parseContentBlocks(wpPost.contentHtml)) {
      if (block.type === 'text') {
        content.push({ id: uuidv4(), type: 'text', text: block.text });
      } else if (block.type === 'image') {
        const img = await saveDownloadedImage(block.src);
        content.push({ id: uuidv4(), type: 'image', ...img });
      } else if (block.type === 'gallery') {
        const cells = [];
        for (const src of block.srcs) cells.push({ type: 'image', ...(await saveDownloadedImage(src)) });
        const rows = [];
        for (let i = 0; i < cells.length; i += 3) {
          const row = cells.slice(i, i + 3);
          while (row.length < 3) row.push(null);
          rows.push(row);
        }
        content.push({ id: uuidv4(), type: 'table', cols: 3, rows });
      }
    }
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    return res.status(502).json({ error: `Import failed: ${err.message}` });
  }

  const meta = { title, createdAt: new Date().toISOString(), hikeDate };
  writeJson(path.join(dir, 'meta.json'), meta);
  writeJson(path.join(dir, 'content.json'), content);

  res.status(201).json({ id, ...meta });
});

app.patch('/api/blogs/:blogId/posts/:postId', requireAuth, (req, res) => {
  const dir = postDir(req.session.username, req.params.blogId, req.params.postId);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Post not found' });
  const metaFile = path.join(dir, 'meta.json');
  const meta = readJson(metaFile);
  if (req.body.title !== undefined) meta.title = req.body.title;
  if (req.body.hikeDate !== undefined) meta.hikeDate = req.body.hikeDate;
  writeJson(metaFile, meta);
  res.json({ id: req.params.postId, ...meta });
});

app.get('/api/blogs/:blogId/posts/:postId', requireAuth, (req, res) => {
  const dir = postDir(req.session.username, req.params.blogId, req.params.postId);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Not found' });

  const meta = readJson(path.join(dir, 'meta.json'));
  const content = readJson(path.join(dir, 'content.json'));
  res.json({ id: req.params.postId, ...meta, content });
});

// Add a text block to a post
app.post('/api/blogs/:blogId/posts/:postId/blocks/text', requireAuth, (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Text required' });

  const dir = postDir(req.session.username, req.params.blogId, req.params.postId);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Post not found' });

  const contentFile = path.join(dir, 'content.json');
  const content = readJson(contentFile);
  const block = { id: uuidv4(), type: 'text', text };
  spliceBlock(content, block, req.body.insertAt);
  writeJson(contentFile, content);

  res.status(201).json(block);
});

// Upload an image block to a post
app.post('/api/blogs/:blogId/posts/:postId/blocks/image', requireAuth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Image required' });

  const dir = postDir(req.session.username, req.params.blogId, req.params.postId);
  const contentFile = path.join(dir, 'content.json');
  const content = readJson(contentFile);

  const imageUrl = `/data/blogs/${req.session.username}/${req.params.blogId}/posts/${req.params.postId}/images/${req.file.filename}`;
  const block = { id: uuidv4(), type: 'image', filename: req.file.filename, url: imageUrl };
  spliceBlock(content, block, req.body.insertAt);
  writeJson(contentFile, content);

  res.status(201).json(block);
});

// Delete a blog and all its contents
app.delete('/api/blogs/:blogId', requireAuth, (req, res) => {
  const dir = blogDir(req.session.username, req.params.blogId);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Not found' });
  fs.rmSync(dir, { recursive: true, force: true });
  res.json({ ok: true });
});

// Delete a post and all its contents
app.delete('/api/blogs/:blogId/posts/:postId', requireAuth, (req, res) => {
  const dir = postDir(req.session.username, req.params.blogId, req.params.postId);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Not found' });
  fs.rmSync(dir, { recursive: true, force: true });
  res.json({ ok: true });
});

// Set or clear a caption on an image block
app.put('/api/blogs/:blogId/posts/:postId/blocks/:blockId/caption', requireAuth, (req, res) => {
  const dir = postDir(req.session.username, req.params.blogId, req.params.postId);
  const contentFile = path.join(dir, 'content.json');
  const content = readJson(contentFile);
  const block = content.find(b => b.id === req.params.blockId && b.type === 'image');
  if (!block) return res.status(404).json({ error: 'Image block not found' });
  block.caption = req.body.caption || '';
  writeJson(contentFile, content);
  res.json(block);
});

// Update a text block
app.put('/api/blogs/:blogId/posts/:postId/blocks/:blockId', requireAuth, (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Text required' });

  const dir = postDir(req.session.username, req.params.blogId, req.params.postId);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Post not found' });

  const contentFile = path.join(dir, 'content.json');
  const content = readJson(contentFile);
  const block = content.find(b => b.id === req.params.blockId);
  if (!block || block.type !== 'text') return res.status(404).json({ error: 'Text block not found' });

  block.text = text;
  writeJson(contentFile, content);
  res.json(block);
});

// Replace an image block
app.put('/api/blogs/:blogId/posts/:postId/blocks/:blockId/image', requireAuth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Image required' });

  const dir = postDir(req.session.username, req.params.blogId, req.params.postId);
  const contentFile = path.join(dir, 'content.json');
  const content = readJson(contentFile);
  const block = content.find(b => b.id === req.params.blockId);
  if (!block || block.type !== 'image') return res.status(404).json({ error: 'Image block not found' });

  if (block.filename) {
    const oldPath = path.join(dir, 'images', block.filename);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }

  block.filename = req.file.filename;
  block.url = `/data/blogs/${req.session.username}/${req.params.blogId}/posts/${req.params.postId}/images/${req.file.filename}`;
  writeJson(contentFile, content);
  res.json(block);
});

// Delete a block
app.delete('/api/blogs/:blogId/posts/:postId/blocks/:blockId', requireAuth, (req, res) => {
  const dir = postDir(req.session.username, req.params.blogId, req.params.postId);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Post not found' });

  const contentFile = path.join(dir, 'content.json');
  const content = readJson(contentFile);
  const idx = content.findIndex(b => b.id === req.params.blockId);
  if (idx === -1) return res.status(404).json({ error: 'Block not found' });

  const [removed] = content.splice(idx, 1);
  if (removed.type === 'image' && removed.filename) {
    const imgPath = path.join(dir, 'images', removed.filename);
    if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
  }
  if (removed.type === 'table') {
    removed.rows.forEach(row => row.forEach(cell => {
      if (cell && cell.type === 'image' && cell.filename) {
        const imgPath = path.join(dir, 'images', cell.filename);
        if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
      }
    }));
  }

  writeJson(contentFile, content);
  res.json({ ok: true });
});

// Reorder cells within a table block
app.put('/api/blogs/:blogId/posts/:postId/blocks/:blockId/order', requireAuth, (req, res) => {
  const from = parseInt(req.body.from);
  const to   = parseInt(req.body.to);
  if (isNaN(from) || isNaN(to) || from === to) return res.json({ ok: true });

  const dir = postDir(req.session.username, req.params.blogId, req.params.postId);
  const contentFile = path.join(dir, 'content.json');
  const content = readJson(contentFile);
  const block = content.find(b => b.id === req.params.blockId && b.type === 'table');
  if (!block) return res.status(404).json({ error: 'Table not found' });

  const flat = block.rows.flat();
  if (from < 0 || from >= flat.length || to < 0 || to >= flat.length) {
    return res.status(400).json({ error: 'Index out of range' });
  }

  const [item] = flat.splice(from, 1);
  flat.splice(to, 0, item);

  const rows = [];
  for (let i = 0; i < flat.length; i += block.cols) {
    const row = flat.slice(i, i + block.cols);
    while (row.length < block.cols) row.push(null);
    rows.push(row);
  }
  while (rows.length > 1 && rows[rows.length - 1].every(c => c === null)) rows.pop();
  block.rows = rows;

  writeJson(contentFile, content);
  res.json({ ok: true });
});

// Create a gallery — uploads images and builds a 3-column table block in one step
app.post('/api/blogs/:blogId/posts/:postId/blocks/gallery', requireAuth, upload.array('images', 50), (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'No images provided' });

  const dir = postDir(req.session.username, req.params.blogId, req.params.postId);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Post not found' });

  const base = `/data/blogs/${req.session.username}/${req.params.blogId}/posts/${req.params.postId}/images/`;
  const cells = req.files.map(f => ({ type: 'image', filename: f.filename, url: base + f.filename }));

  const rows = [];
  for (let i = 0; i < cells.length; i += 3) {
    const row = cells.slice(i, i + 3);
    while (row.length < 3) row.push(null);
    rows.push(row);
  }

  const contentFile = path.join(dir, 'content.json');
  const content = readJson(contentFile);
  const block = { id: uuidv4(), type: 'table', cols: 3, rows };
  spliceBlock(content, block, req.body.insertAt);
  writeJson(contentFile, content);
  res.status(201).json(block);
});

// Create a table block
app.post('/api/blogs/:blogId/posts/:postId/blocks/table', requireAuth, (req, res) => {
  const cols = parseInt(req.body.cols);
  if (!cols || cols < 1 || cols > 3) return res.status(400).json({ error: 'cols must be 1–3' });

  const dir = postDir(req.session.username, req.params.blogId, req.params.postId);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Post not found' });

  const contentFile = path.join(dir, 'content.json');
  const content = readJson(contentFile);
  const block = { id: uuidv4(), type: 'table', cols, rows: [new Array(cols).fill(null)] };
  spliceBlock(content, block, req.body.insertAt);
  writeJson(contentFile, content);
  res.status(201).json(block);
});

// Add a row to a table
app.post('/api/blogs/:blogId/posts/:postId/blocks/:blockId/rows', requireAuth, (req, res) => {
  const dir = postDir(req.session.username, req.params.blogId, req.params.postId);
  const contentFile = path.join(dir, 'content.json');
  const content = readJson(contentFile);
  const block = content.find(b => b.id === req.params.blockId && b.type === 'table');
  if (!block) return res.status(404).json({ error: 'Table not found' });

  block.rows.push(new Array(block.cols).fill(null));
  writeJson(contentFile, content);
  res.json({ ok: true });
});

// Delete a row from a table
app.delete('/api/blogs/:blogId/posts/:postId/blocks/:blockId/rows/:row', requireAuth, (req, res) => {
  const rowIdx = parseInt(req.params.row);
  const dir = postDir(req.session.username, req.params.blogId, req.params.postId);
  const contentFile = path.join(dir, 'content.json');
  const content = readJson(contentFile);
  const block = content.find(b => b.id === req.params.blockId && b.type === 'table');
  if (!block || rowIdx < 0 || rowIdx >= block.rows.length) return res.status(404).json({ error: 'Row not found' });

  block.rows[rowIdx].forEach(cell => {
    if (cell && cell.type === 'image' && cell.filename) {
      const imgPath = path.join(dir, 'images', cell.filename);
      if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
    }
  });
  block.rows.splice(rowIdx, 1);
  writeJson(contentFile, content);
  res.json({ ok: true });
});

// Set a cell to text
app.put('/api/blogs/:blogId/posts/:postId/blocks/:blockId/cells/:row/:col', requireAuth, (req, res) => {
  const rowIdx = parseInt(req.params.row);
  const colIdx = parseInt(req.params.col);
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Text required' });

  const dir = postDir(req.session.username, req.params.blogId, req.params.postId);
  const contentFile = path.join(dir, 'content.json');
  const content = readJson(contentFile);
  const block = content.find(b => b.id === req.params.blockId && b.type === 'table');
  if (!block || !block.rows[rowIdx] || block.rows[rowIdx][colIdx] === undefined) {
    return res.status(404).json({ error: 'Cell not found' });
  }

  const old = block.rows[rowIdx][colIdx];
  if (old && old.type === 'image' && old.filename) {
    const imgPath = path.join(dir, 'images', old.filename);
    if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
  }

  block.rows[rowIdx][colIdx] = { type: 'text', text };
  writeJson(contentFile, content);
  res.json({ ok: true });
});

// Set a cell to an image
app.put('/api/blogs/:blogId/posts/:postId/blocks/:blockId/cells/:row/:col/image', requireAuth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Image required' });

  const rowIdx = parseInt(req.params.row);
  const colIdx = parseInt(req.params.col);
  const dir = postDir(req.session.username, req.params.blogId, req.params.postId);
  const contentFile = path.join(dir, 'content.json');
  const content = readJson(contentFile);
  const block = content.find(b => b.id === req.params.blockId && b.type === 'table');
  if (!block || !block.rows[rowIdx] || block.rows[rowIdx][colIdx] === undefined) {
    return res.status(404).json({ error: 'Cell not found' });
  }

  const old = block.rows[rowIdx][colIdx];
  if (old && old.type === 'image' && old.filename) {
    const imgPath = path.join(dir, 'images', old.filename);
    if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
  }

  const url = `/data/blogs/${req.session.username}/${req.params.blogId}/posts/${req.params.postId}/images/${req.file.filename}`;
  const oldCaption = (old && old.type === 'image') ? old.caption : undefined;
  block.rows[rowIdx][colIdx] = { type: 'image', filename: req.file.filename, url };
  if (oldCaption) block.rows[rowIdx][colIdx].caption = oldCaption;
  writeJson(contentFile, content);
  res.json({ ok: true });
});

// Set caption on a cell image
app.put('/api/blogs/:blogId/posts/:postId/blocks/:blockId/cells/:row/:col/caption', requireAuth, (req, res) => {
  const rowIdx = parseInt(req.params.row);
  const colIdx = parseInt(req.params.col);
  const dir = postDir(req.session.username, req.params.blogId, req.params.postId);
  const contentFile = path.join(dir, 'content.json');
  const content = readJson(contentFile);
  const block = content.find(b => b.id === req.params.blockId && b.type === 'table');
  if (!block || !block.rows[rowIdx] || !block.rows[rowIdx][colIdx]) {
    return res.status(404).json({ error: 'Cell not found' });
  }
  const cell = block.rows[rowIdx][colIdx];
  if (cell.type !== 'image') return res.status(400).json({ error: 'Cell is not an image' });
  cell.caption = req.body.caption || '';
  writeJson(contentFile, content);
  res.json({ ok: true });
});

// Clear a cell
app.delete('/api/blogs/:blogId/posts/:postId/blocks/:blockId/cells/:row/:col', requireAuth, (req, res) => {
  const rowIdx = parseInt(req.params.row);
  const colIdx = parseInt(req.params.col);
  const dir = postDir(req.session.username, req.params.blogId, req.params.postId);
  const contentFile = path.join(dir, 'content.json');
  const content = readJson(contentFile);
  const block = content.find(b => b.id === req.params.blockId && b.type === 'table');
  if (!block || !block.rows[rowIdx] || block.rows[rowIdx][colIdx] === undefined) {
    return res.status(404).json({ error: 'Cell not found' });
  }

  const old = block.rows[rowIdx][colIdx];
  if (old && old.type === 'image' && old.filename) {
    const imgPath = path.join(dir, 'images', old.filename);
    if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
  }

  block.rows[rowIdx][colIdx] = null;
  writeJson(contentFile, content);
  res.json({ ok: true });
});

// --- Public viewing routes (no auth required) ---
app.get('/api/view/:username/:blogId', (req, res) => {
  const dir = blogDir(req.params.username, req.params.blogId);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Not found' });
  const meta = readJson(path.join(dir, 'meta.json'));
  res.json({ id: req.params.blogId, owner: req.params.username, ...meta });
});

app.get('/api/view/:username/:blogId/posts', (req, res) => {
  const postsDir = path.join(blogDir(req.params.username, req.params.blogId), 'posts');
  if (!fs.existsSync(postsDir)) return res.json([]);
  const posts = fs.readdirSync(postsDir)
    .filter(id => fs.existsSync(path.join(postsDir, id, 'meta.json')))
    .map(id => {
      const contentFile = path.join(postsDir, id, 'content.json');
      const photoCount = fs.existsSync(contentFile) ? countPhotos(readJson(contentFile)) : 0;
      return { id, ...readJson(path.join(postsDir, id, 'meta.json')), photoCount };
    });
  posts.sort((a, b) => new Date(b.hikeDate || b.createdAt) - new Date(a.hikeDate || a.createdAt));
  res.json(posts);
});

app.get('/api/view/:username/:blogId/posts/:postId', (req, res) => {
  const dir = postDir(req.params.username, req.params.blogId, req.params.postId);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Not found' });
  const meta = readJson(path.join(dir, 'meta.json'));
  const content = readJson(path.join(dir, 'content.json'));
  res.json({ id: req.params.postId, ...meta, content });
});


app.listen(PORT, () => console.log(`Blog server running at http://localhost:${PORT}`));
