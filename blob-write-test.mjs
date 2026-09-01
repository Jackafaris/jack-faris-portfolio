import fs from 'node:fs';
const env = fs.readFileSync('/home/jackfaris99/jackfaris-site/.env.local', 'utf8');
const TOK = env.match(/BLOB_READ_WRITE_TOKEN="([^"]+)"/)[1];
const SID = TOK.split('_')[3];
const BODY = JSON.stringify({ positions: [], _v: 1, t: new Date().toISOString() });

const variants = [
  {
    name: 'A vercel.com/api/blob + store-id (no prefix)',
    url: `https://vercel.com/api/blob/picks.json?access=public&contentType=application%2Fjson`,
    headers: { authorization: `Bearer ${TOK}`, 'x-vercel-blob-store-id': SID, 'x-api-version': '12', 'Content-Type': 'application/json' },
  },
  {
    name: 'B vercel.com/api/blob + store-id (WITH store_ prefix)',
    url: `https://vercel.com/api/blob/picks.json?access=public&contentType=application%2Fjson`,
    headers: { authorization: `Bearer ${TOK}`, 'x-vercel-blob-store-id': `store_${SID}`, 'x-api-version': '12', 'Content-Type': 'application/json' },
  },
  {
    name: 'C direct storage host PUT + bearer',
    url: `https://${SID}.blob.vercel-storage.com/picks.json`,
    headers: { authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
  },
  {
    name: 'D vercel.com/api/blob + x-api-key',
    url: `https://vercel.com/api/blob/picks.json?access=public&contentType=application%2Fjson`,
    headers: { 'x-api-key': TOK, 'x-vercel-blob-store-id': SID, 'x-api-version': '12', 'Content-Type': 'application/json' },
  },
];

for (const v of variants) {
  try {
    const r = await fetch(v.url, { method: 'PUT', headers: v.headers, body: BODY });
    const t = await r.text();
    console.log(`${v.name}\n   -> HTTP ${r.status} ${t.slice(0, 120)}`);
  } catch (e) {
    console.log(`${v.name}\n   -> EXC ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 1000));
}

// readback check
const rb = await fetch(`https://${SID}.public.blob.vercel-storage.com/picks.json`);
console.log(`READBACK ${rb.status} ${ (await rb.text()).slice(0,80) }`);
