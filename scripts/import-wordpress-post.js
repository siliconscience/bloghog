#!/usr/bin/env node
// One-off CLI tool: import a single WordPress.com post into a bloghog blog.
//
// Usage:
//   node scripts/import-wordpress-post.js <wordpress-post-url> \
//     --username <bloghog-username> --password <bloghog-password> \
//     --blog <bloghog-blog-id> [--host http://localhost:8000] [--hike-date YYYY-MM-DD]
//
// Maps WordPress content to bloghog blocks:
//   <p>                              -> text block
//   <figure class="wp-block-image">  -> image block
//   <figure class="wp-block-gallery"> (with nested wp-block-image figures) -> gallery block

const cheerio = require('cheerio');

function parseArgs(argv) {
  const args = { host: 'http://localhost:8000' };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--username') args.username = argv[++i];
    else if (a === '--password') args.password = argv[++i];
    else if (a === '--blog') args.blog = argv[++i];
    else if (a === '--host') args.host = argv[++i];
    else if (a === '--hike-date') args.hikeDate = argv[++i];
    else positional.push(a);
  }
  args.postUrl = positional[0];
  return args;
}

function usageAndExit() {
  console.error(
    'Usage: node scripts/import-wordpress-post.js <wordpress-post-url> ' +
    '--username <user> --password <pass> --blog <blogId> [--host http://localhost:8000] [--hike-date YYYY-MM-DD]'
  );
  process.exit(1);
}

function wpApiUrlFor(postUrl) {
  const u = new URL(postUrl);
  const site = u.hostname;
  const slug = u.pathname.replace(/\/+$/, '').split('/').pop();
  return `https://public-api.wordpress.com/rest/v1.1/sites/${site}/posts/slug:${slug}`;
}

async function fetchWpPost(postUrl) {
  const apiUrl = wpApiUrlFor(postUrl);
  const res = await fetch(apiUrl);
  if (!res.ok) throw new Error(`WordPress API fetch failed (${res.status}) for ${apiUrl}`);
  const post = await res.json();
  return {
    title: post.title,
    date: post.date,
    contentHtml: post.content
  };
}

// Parse WP post content HTML into an ordered list of bloghog-shaped blocks:
//   { type: 'text', text }
//   { type: 'image', src }
//   { type: 'gallery', srcs: [] }
function parseContentBlocks(html) {
  const $ = cheerio.load(html, null, false);
  const blocks = [];

  $.root().children().each((_, el) => {
    const $el = $(el);
    const cls = $el.attr('class') || '';

    if (el.tagName === 'figure' && /\bwp-block-gallery\b/.test(cls)) {
      const srcs = $el.find('img').map((_, img) => $(img).attr('src')).get();
      if (srcs.length) blocks.push({ type: 'gallery', srcs });
      return;
    }

    if (el.tagName === 'figure' && /\bwp-block-image\b/.test(cls)) {
      const src = $el.find('img').first().attr('src');
      if (src) blocks.push({ type: 'image', src });
      return;
    }

    if (el.tagName === 'p') {
      const text = $el.text().trim();
      if (text) blocks.push({ type: 'text', text });
      return;
    }

    // Fallback: any other block-level element with visible text becomes a text block.
    const text = $el.text().trim();
    if (text) blocks.push({ type: 'text', text });
  });

  return blocks;
}

// Strip WordPress's resize query string (e.g. "?w=771") to fetch the original full-resolution file.
function originalImageUrl(src) {
  return src.split('?')[0];
}

async function downloadImage(src) {
  const url = originalImageUrl(src);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image download failed (${res.status}) for ${url}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') || 'image/jpeg';
  const filename = decodeURIComponent(url.split('/').pop()) || 'image.jpg';
  return { buffer, contentType, filename };
}

async function login(host, username, password) {
  const res = await fetch(`${host}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  if (!res.ok) throw new Error(`Login failed (${res.status})`);
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('Login succeeded but no session cookie was returned');
  return setCookie.split(';')[0];
}

async function createPost(host, cookie, blogId, title, hikeDate) {
  const res = await fetch(`${host}/api/blogs/${blogId}/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ title, hikeDate })
  });
  if (!res.ok) throw new Error(`Create post failed (${res.status}): ${await res.text()}`);
  const post = await res.json();
  return post.id;
}

async function addTextBlock(host, cookie, blogId, postId, text) {
  const res = await fetch(`${host}/api/blogs/${blogId}/posts/${postId}/blocks/text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ text })
  });
  if (!res.ok) throw new Error(`Add text block failed (${res.status}): ${await res.text()}`);
}

async function addImageBlock(host, cookie, blogId, postId, src) {
  const { buffer, contentType, filename } = await downloadImage(src);
  const form = new FormData();
  form.append('image', new Blob([buffer], { type: contentType }), filename);
  const res = await fetch(`${host}/api/blogs/${blogId}/posts/${postId}/blocks/image`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: form
  });
  if (!res.ok) throw new Error(`Add image block failed (${res.status}): ${await res.text()}`);
}

async function addGalleryBlock(host, cookie, blogId, postId, srcs) {
  const images = await Promise.all(srcs.map(downloadImage));
  const form = new FormData();
  for (const { buffer, contentType, filename } of images) {
    form.append('images', new Blob([buffer], { type: contentType }), filename);
  }
  const res = await fetch(`${host}/api/blogs/${blogId}/posts/${postId}/blocks/gallery`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: form
  });
  if (!res.ok) throw new Error(`Add gallery block failed (${res.status}): ${await res.text()}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.postUrl || !args.username || !args.password || !args.blog) usageAndExit();

  console.log(`Fetching ${args.postUrl} ...`);
  const wpPost = await fetchWpPost(args.postUrl);
  const blocks = parseContentBlocks(wpPost.contentHtml);
  console.log(`Found "${wpPost.title}" — ${blocks.length} block(s) to import.`);

  const hikeDate = args.hikeDate || wpPost.date.slice(0, 10);

  console.log('Logging in ...');
  const cookie = await login(args.host, args.username, args.password);

  console.log('Creating post ...');
  const postId = await createPost(args.host, cookie, args.blog, wpPost.title, hikeDate);

  for (const [i, block] of blocks.entries()) {
    console.log(`Adding block ${i + 1}/${blocks.length} (${block.type}) ...`);
    if (block.type === 'text') await addTextBlock(args.host, cookie, args.blog, postId, block.text);
    else if (block.type === 'image') await addImageBlock(args.host, cookie, args.blog, postId, block.src);
    else if (block.type === 'gallery') await addGalleryBlock(args.host, cookie, args.blog, postId, block.srcs);
  }

  console.log(`Done. Post created: ${args.host}/post.html?blog=${args.blog}&post=${postId}`);
}

main().catch(err => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
