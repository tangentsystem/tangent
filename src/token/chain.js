// Small raw account readers shared by detection and stats: SPL / Token-2022 mints, token account
// balances, Metaplex metadata and the Token-2022 metadata extension.
// Layouts are the SPL ones (via @solana/spl-token where it has a decoder).
import { PublicKey } from '@solana/web3.js';
import { unpackMint, unpackAccount, getExtensionData, ExtensionType } from '@solana/spl-token';
import { PROGRAM_IDS } from './sdk.js';

export const TOKEN_PROGRAMS = new Set([PROGRAM_IDS.token, PROGRAM_IDS.token2022]);

/** { supply: bigint, decimals, tokenProgram, tlv } or null when the account is not a mint. */
export function readMint(address, info) {
  if (!info) return null;
  const owner = info.owner.toBase58();
  if (!TOKEN_PROGRAMS.has(owner)) return null;
  try {
    const m = unpackMint(new PublicKey(address), info, info.owner);
    return { supply: m.supply, decimals: m.decimals, tokenProgram: owner, tlvData: m.tlvData };
  } catch {
    return null;
  }
}

/** Raw token amount of a token account (SPL or Token-2022), or null. */
export function readTokenAmount(address, info) {
  if (!info) return null;
  const owner = info.owner.toBase58();
  if (!TOKEN_PROGRAMS.has(owner)) return null;
  try {
    return unpackAccount(new PublicKey(address), info, info.owner).amount;
  } catch {
    return null;
  }
}

function readBorshString(buf, off) {
  if (off + 4 > buf.length) return [null, off];
  const len = buf.readUInt32LE(off);
  const start = off + 4;
  if (len > 1024 || start + len > buf.length) return [null, off];
  const s = buf.subarray(start, start + len).toString('utf8').replace(/\0+$/g, '').trim();
  return [s, start + len];
}

/** Metaplex metadata PDA for a mint (program id from the DBC SDK). */
export function metaplexMetadataPda(mint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), new PublicKey(PROGRAM_IDS.metaplex).toBuffer(), new PublicKey(mint).toBuffer()],
    new PublicKey(PROGRAM_IDS.metaplex),
  )[0];
}

/** Metaplex Metadata account: key(1) update_authority(32) mint(32) name symbol uri. */
export function readMetaplexMetadata(info) {
  if (!info || info.owner.toBase58() !== PROGRAM_IDS.metaplex) return null;
  const d = Buffer.from(info.data);
  if (d.length < 65 + 12) return null;
  let off = 65;
  let name, symbol, uri;
  [name, off] = readBorshString(d, off);
  [symbol, off] = readBorshString(d, off);
  [uri, off] = readBorshString(d, off);
  if (name === null || symbol === null) return null;
  return { name, symbol, uri: uri || '' };
}

/** Token-2022 TokenMetadata extension: update_authority(32) mint(32) name symbol uri ... */
export function readToken2022Metadata(mint) {
  if (!mint || mint.tokenProgram !== PROGRAM_IDS.token2022 || !mint.tlvData || !mint.tlvData.length) return null;
  try {
    const ext = getExtensionData(ExtensionType.TokenMetadata, Buffer.from(mint.tlvData));
    if (!ext) return null;
    const d = Buffer.from(ext);
    let off = 64;
    let name, symbol, uri;
    [name, off] = readBorshString(d, off);
    [symbol, off] = readBorshString(d, off);
    [uri, off] = readBorshString(d, off);
    if (name === null || symbol === null) return null;
    return { name, symbol, uri: uri || '' };
  } catch {
    return null;
  }
}

