#!/usr/bin/env node
// One-off CLI tool: import a single WordPress.com post into a bloghog blog.
// Thin client around the server's own POST /api/blogs/:blogId/posts/import-wordpress
// endpoint, so the fetch/parse/download logic lives in one place (lib/wordpress-import.js).
//
// Usage:
//   node scripts/import-wordpress-post.js <wordpress-post-url> \
//     --username <bloghog-username> --password <bloghog-password> \
//     --blog <bloghog-blog-id> [--host http://localhost:8000] [--hike-date YYYY-MM-DD] [--title "..."]

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
    else if (a === '--title') args.title = argv[++i];
    else positional.push(a);
  }
  args.postUrl = positional[0];
  return args;
}

function usageAndExit() {
  console.error(
    'Usage: node scripts/import-wordpress-post.js <wordpress-post-url> ' +
    '--username <user> --password <pass> --blog <blogId> [--host http://localhost:8000] ' +
    '[--hike-date YYYY-MM-DD] [--title "..."]'
  );
  process.exit(1);
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.postUrl || !args.username || !args.password || !args.blog) usageAndExit();

  console.log('Logging in ...');
  const cookie = await login(args.host, args.username, args.password);

  console.log(`Importing ${args.postUrl} ...`);
  const res = await fetch(`${args.host}/api/blogs/${args.blog}/posts/import-wordpress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ url: args.postUrl, title: args.title, hikeDate: args.hikeDate })
  });
  if (!res.ok) throw new Error(`Import failed (${res.status}): ${await res.text()}`);
  const post = await res.json();

  console.log(`Done. Post created: ${args.host}/post.html?blog=${args.blog}&post=${post.id}`);
}

main().catch(err => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
