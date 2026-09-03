// Shared helpers for importing a WordPress.com post: fetching it via the
// public REST API and mapping its content HTML into bloghog-shaped blocks.
// Used by the server's import endpoint and by scripts/import-wordpress-post.js.

const cheerio = require('cheerio');
const sharp = require('sharp');

// Matches the client-side reduction offered in post.html: cap the longest side at
// 2x the blog's 800px display width, so there's no visible quality loss on the page.
const MAX_DIM = 1600;
const JPEG_QUALITY = 85;

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
  const rawBuffer = Buffer.from(await res.arrayBuffer());
  const originalName = decodeURIComponent(url.split('/').pop()) || 'image.jpg';

  const buffer = await sharp(rawBuffer)
    .resize({ width: MAX_DIM, height: MAX_DIM, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
  const filename = originalName.replace(/\.[^.]+$/, '') + '.jpg';

  return { buffer, contentType: 'image/jpeg', filename };
}

module.exports = { wpApiUrlFor, fetchWpPost, parseContentBlocks, downloadImage };
