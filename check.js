#!/usr/bin/env node
// solana-program-audit-check
// For a Solana program ID: is it upgradeable, who holds the upgrade authority, is its build verified,
// and which published audits name it on Trustblock? Prints JSON. Read-only, no API key, no dependencies (Node 18+).
//
//   node check.js <program-id> [<program-id> ...] [--rpc URL] [--no-registry] [--no-trustblock] [--compact]
//
// Sources, all public:
//   1. Solana JSON-RPC (default https://api.mainnet-beta.solana.com, or SOLANA_RPC / --rpc): the program account,
//      its ProgramData account (upgrade authority, last deploy slot) and, for a multisig check, the authority account.
//   2. OtterSec's verified-builds registry: https://verify.osec.io/status/<program-id>
//   3. Trustblock's public pages: https://app.trustblock.run (search by address, project page, audit pages).

'use strict';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const rpcUrl = opt('--rpc') || process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const ids = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--rpc');
const UA = 'solana-program-audit-check/0.1 (+read-only)';
const APP = 'https://app.trustblock.run';

if (ids.length === 0 || flag('--help')) {
  console.error('usage: node check.js <program-id> [<program-id> ...] [--rpc URL] [--no-registry] [--no-trustblock] [--compact]');
  process.exit(ids.length === 0 && !flag('--help') ? 2 : 0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- base58 -------------------------------------------------------------------------------------------------
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function toBase58(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  return '1'.repeat(zeros) + out;
}
function fromBase58(s) {
  let n = 0n;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error(`not base58: ${c}`);
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  return Uint8Array.from([...new Array(zeros).fill(0), ...bytes]);
}

// ---- Solana JSON-RPC ----------------------------------------------------------------------------------------
async function rpc(method, params) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(30000)
    });
    if (r.status === 429) {
      if (attempt < 2) { await sleep(2000 * (attempt + 1)); continue; }
      throw new Error(`${method}: the RPC answered 429 (rate limited); stop and retry later, or pass --rpc with your own endpoint`);
    }
    const j = await r.json();
    if (j.error) {
      // public RPC nodes sometimes fail a history read with "please try again": wait and retry twice
      if (/try again/i.test(j.error.message) && attempt < 2) { await sleep(3000 * (attempt + 1)); continue; }
      throw new Error(`${method}: ${j.error.message}`);
    }
    return j.result;
  }
}
// dataSlice keeps reads small: the 64-byte header, not the program's ELF
async function getAccount(address, length = 64) {
  const r = await rpc('getAccountInfo', [address, { encoding: 'base64', dataSlice: { offset: 0, length } }]);
  if (!r.value) return null;
  return { owner: r.value.owner, executable: r.value.executable, space: r.value.space ?? 0, data: Uint8Array.from(Buffer.from(r.value.data[0], 'base64')) };
}
async function getBlockTime(slot) {
  try { return await rpc('getBlockTime', [slot]); } catch { return null; }
}

// ---- program account layouts --------------------------------------------------------------------------------
const LOADER_UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';
const LOADER_V4 = 'LoaderV411111111111111111111111111111111111';
const LOADER_V2 = 'BPFLoader2111111111111111111111111111111111';
const LOADER_V1 = 'BPFLoader1111111111111111111111111111111111';

function decodeProgram(acc) {
  const dv = new DataView(acc.data.buffer, acc.data.byteOffset, acc.data.byteLength);
  if (acc.owner === LOADER_UPGRADEABLE) {
    // UpgradeableLoaderState::Program { tag u32 = 2, programdata: Pubkey }
    if (acc.data.length < 36 || dv.getUint32(0, true) !== 2) return { kind: 'not-a-program' };
    return { kind: 'upgradeable', programData: toBase58(acc.data.subarray(4, 36)) };
  }
  if (acc.owner === LOADER_V4) {
    // LoaderV4State { slot u64, authority_or_next_version Pubkey, status u64 (0 retracted, 1 deployed, 2 finalized) }
    if (acc.data.length < 48) return { kind: 'not-a-program' };
    const status = Number(dv.getBigUint64(40, true));
    const s = status === 0 ? 'retracted' : status === 1 ? 'deployed' : 'finalized';
    return { kind: 'v4', slot: Number(dv.getBigUint64(0, true)), status: s, authority: s === 'finalized' ? null : toBase58(acc.data.subarray(8, 40)) };
  }
  if ((acc.owner === LOADER_V2 || acc.owner === LOADER_V1) && acc.executable) return { kind: 'legacy', loader: acc.owner };
  return { kind: 'not-a-program' };
}
function decodeProgramData(data) {
  // UpgradeableLoaderState::ProgramData { tag u32 = 3, slot u64, upgrade_authority: Option<Pubkey> }
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 13 || dv.getUint32(0, true) !== 3) throw new Error('not a ProgramData account');
  return { slot: Number(dv.getBigUint64(4, true)), authority: data[12] === 1 ? toBase58(data.subarray(13, 45)) : null };
}

// ---- who holds the authority --------------------------------------------------------------------------------
// A wallet key is a point on the ed25519 curve; a program-derived address (PDA) is not. A multisig vault is a PDA.
const SQUADS_V4 = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';
const SQUADS_V3 = 'SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu';
const SPL_GOVERNANCE = 'GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw';
const SYSTEM = '11111111111111111111111111111111';
const P = 2n ** 255n - 19n;
const mod = (a) => ((a % P) + P) % P;
function pow(b, e) { let r = 1n; let x = mod(b); while (e > 0n) { if (e & 1n) r = (r * x) % P; x = (x * x) % P; e >>= 1n; } return r; }
const D = mod(-121665n * pow(121666n, P - 2n));
function isOnCurve(key) {
  if (key.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? key[i] & 0x7f : key[i]);
  const y2 = mod(y * y);
  const x2 = mod(mod(y2 - 1n) * pow(mod(D * y2 + 1n), P - 2n));
  return x2 === 0n || pow(x2, (P - 1n) / 2n) === 1n;
}
async function latestTxPrograms(address) {
  const sigs = await rpc('getSignaturesForAddress', [address, { limit: 3 }]);
  const keys = new Set();
  for (const s of sigs) {
    const tx = await rpc('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 0 }]);
    for (const k of tx?.transaction.message.accountKeys ?? []) keys.add(typeof k === 'string' ? k : k.pubkey);
  }
  return keys;
}
async function classifyAuthority(authority) {
  if (isOnCurve(fromBase58(authority))) return 'single key (wallet)';
  const acc = await getAccount(authority, 0);
  const owner = acc?.owner ?? null;
  if (owner === SQUADS_V4) return 'Squads v4 multisig (account)';
  if (owner === SQUADS_V3) return 'Squads v3 multisig';
  if (owner === SPL_GOVERNANCE) return 'SPL Governance';
  if (!acc || (owner === SYSTEM && acc.space === 0)) {
    let programs;
    try { programs = await latestTxPrograms(authority); } catch { return 'program-derived address (multisig check unavailable: RPC could not read its history)'; }
    if (programs.has(SQUADS_V4)) return 'Squads v4 multisig (vault)';
    if (programs.has(SQUADS_V3)) return 'Squads v3 multisig';
    if (programs.has(SPL_GOVERNANCE)) return 'SPL Governance';
  }
  return 'program-derived address (other program)';
}

// ---- OtterSec verified-builds registry ----------------------------------------------------------------------
async function registryStatus(programId) {
  const out = { registry: 'OtterSec verified builds (verify.osec.io)' };
  const r = await fetch(`https://verify.osec.io/status/${programId}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (r.status === 429) throw new Error('verify.osec.io answered 429 (rate limited); stop and retry later');
  if (!r.ok) return { ...out, verified: false, repo: null, commit: null, lastVerifiedAt: null, message: `http ${r.status}` };
  const j = await r.json();
  return { ...out, verified: j.is_verified === true, repo: j.repo_url || null, commit: j.commit || null, lastVerifiedAt: j.last_verified_at || null, message: j.message || null };
}

// ---- Trustblock public lookup (no key): search page -> project page -> audit pages ---------------------------
async function page(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (r.status === 429) throw new Error('app.trustblock.run answered 429 (rate limited); stop and retry later');
  if (!r.ok) throw new Error(`${url} -> http ${r.status}`);
  return r.text();
}
async function trustblockLookup(programId) {
  const search = await page(`${APP}/?searchTerm=${encodeURIComponent(programId)}`);
  const slugs = [];
  for (const m of search.matchAll(/homepage-record-row/g)) {
    const s = search.slice(m.index, m.index + 900).match(/\/project\/([a-z0-9][a-z0-9-]*)/);
    if (s && !slugs.includes(s[1])) slugs.push(s[1]);
  }
  if (slugs.length === 0) return { found: false, projects: [], audits: [], note: 'No project on Trustblock lists this address.' };
  const projects = [];
  const audits = [];
  for (const slug of slugs.slice(0, 3)) {
    await sleep(300);
    const html = await page(`${APP}/project/${slug}`);
    const ld = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)].map((m) => { try { return JSON.parse(m[1]); } catch { return null; } }).filter(Boolean);
    const web = ld.flatMap((x) => x['@graph'] ?? [x]).find((x) => x['@type'] === 'WebPage');
    const items = web?.mainEntity?.itemListElement ?? [];
    projects.push({ slug, name: web?.about?.name ?? slug, url: `${APP}/project/${slug}`, auditsOnProject: items.length });
    for (const it of items.slice(0, 8)) {
      await sleep(300);
      const a = it.item;
      const auditHtml = await page(a.url);
      audits.push({ project: slug, firm: a.author?.name ?? null, date: a.datePublished ?? null, url: a.url, namesThisProgram: auditHtml.includes(programId) });
    }
  }
  const naming = audits.filter((a) => a.namesThisProgram);
  return {
    found: true,
    projects,
    audits: naming.map(({ namesThisProgram, ...a }) => a),
    otherAuditsOnSameProject: audits.length - naming.length,
    note: naming.length
      ? 'Audits listed are those whose scope on Trustblock names this exact address.'
      : 'The project lists this address, but none of its published audits names it in scope.'
  };
}

// ---- one program --------------------------------------------------------------------------------------------
async function check(programId) {
  try { if (fromBase58(programId).length !== 32) throw new Error(); } catch { return { programId, error: 'not a valid Solana address' }; }
  const acc = await getAccount(programId);
  if (!acc) return { programId, error: 'account not found on this cluster' };
  const program = decodeProgram(acc);
  let slot = null;
  let authority = null;
  let state;
  let reason;
  if (program.kind === 'upgradeable') {
    const pdAcc = await getAccount(program.programData);
    if (!pdAcc) return { programId, error: 'ProgramData account missing (program closed?)' };
    const pd = decodeProgramData(pdAcc.data);
    slot = pd.slot;
    authority = pd.authority;
    state = authority ? 'upgradeable' : 'immutable';
    reason = authority ? 'upgrade authority set' : 'upgrade authority revoked';
  } else if (program.kind === 'v4') {
    slot = program.slot;
    authority = program.authority;
    state = program.status === 'finalized' ? 'immutable' : 'upgradeable';
    reason = `loader v4, ${program.status}`;
  } else if (program.kind === 'legacy') {
    state = 'immutable';
    reason = 'legacy loader (never upgradeable)';
  } else {
    return { programId, error: `not an executable program (owner ${acc.owner})` };
  }
  const time = slot ? await getBlockTime(slot) : null;
  const lastDeployAt = time ? new Date(time * 1000).toISOString().slice(0, 10) : null;
  const authorityKind = authority ? await classifyAuthority(authority) : null;
  const out = {
    programId,
    checkedAt: new Date().toISOString(),
    onChain: {
      rpc: new URL(rpcUrl).host,
      loader: program.kind === 'upgradeable' ? 'BPFLoaderUpgradeable' : program.kind === 'v4' ? 'loader v4' : 'legacy BPF loader',
      state, reason, upgradeAuthority: authority, upgradeAuthorityKind: authorityKind, lastDeploySlot: slot, lastDeployAt
    }
  };
  if (!flag('--no-registry')) out.verifiedBuild = await registryStatus(programId);
  if (!flag('--no-trustblock')) {
    out.trustblock = await trustblockLookup(programId);
    const dates = out.trustblock.audits.map((a) => a.date).filter(Boolean).sort();
    out.deployedAfterLatestAudit = lastDeployAt && dates.length ? lastDeployAt > dates[dates.length - 1] : null;
  }
  return out;
}

(async () => {
  const results = [];
  let failed = false;
  for (const id of ids) {
    try { results.push(await check(id)); } catch (e) { failed = true; results.push({ programId: id, error: e.message }); }
    if (id !== ids[ids.length - 1]) await sleep(1000);
  }
  const body = ids.length === 1 ? results[0] : results;
  console.log(JSON.stringify(body, null, flag('--compact') ? 0 : 2));
  process.exit(failed || results.some((r) => r.error) ? 1 : 0);
})();
