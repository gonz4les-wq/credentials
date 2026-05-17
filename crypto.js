// crypto.js — WebCrypto helpers. All operations stay in the browser.
// AES-GCM-256 for confidentiality+integrity, PBKDF2-SHA256 600k iterations for KDF.

const Crypto = (() => {
  const KDF_ITERATIONS = 600_000;          // OWASP 2023+ recommendation for PBKDF2-SHA256
  const SALT_BYTES = 16;
  const IV_BYTES = 12;

  function randomBytes(n){ return crypto.getRandomValues(new Uint8Array(n)); }

  async function deriveKey(password, salt, iterations = KDF_ITERATIONS){
    const enc = new TextEncoder();
    const material = await crypto.subtle.importKey(
      'raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptJSON(key, obj){
    const iv = randomBytes(IV_BYTES);
    const data = new TextEncoder().encode(JSON.stringify(obj));
    const ct = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, key, data);
    return { iv, ct: new Uint8Array(ct) };
  }

  async function decryptJSON(key, iv, ct){
    const pt = await crypto.subtle.decrypt({ name:'AES-GCM', iv }, key, ct);
    return JSON.parse(new TextDecoder().decode(pt));
  }

  // base64 helpers (for export files)
  function bytesToB64(bytes){
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }
  function b64ToBytes(b64){
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i=0;i<bin.length;i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function uuid(){
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map(x => x.toString(16).padStart(2,'0')).join('');
    return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
  }

  // Cryptographically uniform integer in [0, max)
  function randomInt(max){
    const limit = Math.floor(0xFFFFFFFF / max) * max;
    const buf = new Uint32Array(1);
    let x;
    do { crypto.getRandomValues(buf); x = buf[0]; } while (x >= limit);
    return x % max;
  }

  function generatePassword(opts){
    const { length=20, upper=true, lower=true, digit=true, sym=true, avoidAmbiguous=false } = opts || {};
    let U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let L = 'abcdefghijklmnopqrstuvwxyz';
    let D = '0123456789';
    let S = '!@#$%^&*()-_=+[]{};:,.?/';
    if (avoidAmbiguous){
      U = U.replace(/[OI]/g,''); L = L.replace(/[ol]/g,''); D = D.replace(/[01]/g,'');
    }
    const sets = [];
    if (upper) sets.push(U);
    if (lower) sets.push(L);
    if (digit) sets.push(D);
    if (sym)   sets.push(S);
    if (!sets.length) sets.push(L);
    const pool = sets.join('');
    // Guarantee at least one char from each selected set
    const chars = sets.map(s => s[randomInt(s.length)]);
    while (chars.length < length) chars.push(pool[randomInt(pool.length)]);
    // Fisher-Yates shuffle
    for (let i=chars.length-1;i>0;i--){
      const j = randomInt(i+1);
      [chars[i],chars[j]] = [chars[j],chars[i]];
    }
    return chars.slice(0, length).join('');
  }

  // Rough entropy-based strength score 0..4
  function strengthScore(pw){
    if (!pw) return 0;
    let pool = 0;
    if (/[a-z]/.test(pw)) pool += 26;
    if (/[A-Z]/.test(pw)) pool += 26;
    if (/\d/.test(pw))    pool += 10;
    if (/[^A-Za-z0-9]/.test(pw)) pool += 32;
    const bits = Math.log2(Math.max(pool,1)) * pw.length;
    if (bits < 35) return 1;
    if (bits < 60) return 2;
    if (bits < 90) return 3;
    return 4;
  }

  return {
    KDF_ITERATIONS, SALT_BYTES, IV_BYTES,
    randomBytes, deriveKey, encryptJSON, decryptJSON,
    bytesToB64, b64ToBytes, uuid,
    generatePassword, strengthScore,
  };
})();
