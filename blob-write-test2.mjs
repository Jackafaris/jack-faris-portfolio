import { put, del, head } from '@vercel/blob';
import fs from 'node:fs';

const env = fs.readFileSync('/home/jackfaris99/jackfaris-site/.env.local', 'utf8');
const TOK = (env.match(/BLOB_READ_WRITE_TOKEN="([^"]+)"/) || [])[1];
const SID = TOK ? TOK.split('_')[3] : null;
const BODY = JSON.stringify({ positions: [], _v: 1, t: new Date().toISOString() });
console.log('token present:', !!TOK, 'storeId:', SID);

async function tryPut(label, opts) {
  try {
    const b = await put('picks.json', BODY, opts);
    console.log(`${label}: OK url=${b.url}`);
    return b;
  } catch (e) {
    console.log(`${label}: FAIL ${e.constructor.name}: ${e.message}`);
    return null;
  }
}

// 1) explicit rw token (what a function gets as env)
let b = await tryPut('rw-token explicit', { access: 'public', token: TOK, contentType: 'application/json' });

// 2) no token (SDK reads BLOB_READ_WRITE_TOKEN from env)
if (b) await del(b.url, { access: 'public', token: TOK }).catch(() => {});
process.env.BLOB_READ_WRITE_TOKEN = TOK;
process.env.BLOB_STORE_ID = SID;
delete process.env.VERCEL_OIDC_TOKEN;
b = await tryPut('env rw-token', { access: 'public', contentType: 'application/json' });

// 3) head on public
if (b) {
  const h = await head(b.url, { access: 'public', token: TOK }).catch((e) => e);
  console.log('head:', h && h.etag ? 'OK etag=' + h.etag : h.message || h);
  // public readback
  const r = await fetch(b.url);
  console.log('public readback:', r.status, (await r.text()).slice(0, 60));
  await del(b.url, { access: 'public', token: TOK }).catch(() => {});
}
console.log('done');
