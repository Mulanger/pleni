import type { SearchV2Request } from "../search-v2-types.ts";

export const V2_RANKING_VERSION = "pleni-search-v4";
export const CURSOR_TTL_MS = 30 * 60 * 1000;
export interface SearchCursor {
  binding: string;
  indexVersion: string;
  rankingVersion: string;
  snapshot: string;
  expires: number;
  after: { score: number; date: number; id: string };
  vector: string | null;
}
export class InvalidSearchCursor extends Error {}
const encoder = new TextEncoder();
function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+","-").replaceAll("/","_").replace(/=+$/u,"");
}
function unbase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replaceAll("-","+").replaceAll("_","/")),c=>c.charCodeAt(0));
}
async function key(secret: string): Promise<CryptoKey> {
  if (secret.length<32) throw new Error("cursor_secret_not_configured");
  const material=await crypto.subtle.importKey("raw",encoder.encode(secret),"HKDF",false,["deriveKey"]);
  return crypto.subtle.deriveKey({name:"HKDF",hash:"SHA-256",salt:encoder.encode("pleni-search-v2"),
    info:encoder.encode("encrypted-pagination")},material,{name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
}
export async function searchBinding(request: SearchV2Request, interpretation: unknown): Promise<string> {
  const f=request.filters ?? {};
  const value=JSON.stringify([request.query,request.sort ?? null,request.limit ?? 20,
    ...["person","party","event","date","topic"].map(k=>f[k as keyof typeof f] ?? null),interpretation]);
  return base64(new Uint8Array(await crypto.subtle.digest("SHA-256",encoder.encode(value))));
}
export function packVector(vector: readonly number[]): string {
  if (vector.length!==1024 || vector.some(n=>!Number.isFinite(n))) throw new Error("invalid_vector");
  return base64(new Uint8Array(Float32Array.from(vector).buffer));
}
export function unpackVector(value: string): number[] {
  const bytes=unbase64(value);
  if (bytes.length!==4096) throw new InvalidSearchCursor();
  const vector=Array.from(new Float32Array(bytes.buffer));
  if (vector.some(n=>!Number.isFinite(n))) throw new InvalidSearchCursor();
  return vector;
}
export async function sealCursor(value: SearchCursor, secret: string): Promise<string> {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv},await key(secret),encoder.encode(JSON.stringify(value))));
  const bytes=new Uint8Array(iv.length+encrypted.length); bytes.set(iv); bytes.set(encrypted,12);
  return base64(bytes);
}
export async function openCursor(token: string, secret: string, binding: string, indexVersion: string,
  now: number): Promise<SearchCursor> {
  try {
    if (token.length>14000 || token.length<40) throw new InvalidSearchCursor();
    const bytes=unbase64(token);
    const clear=await crypto.subtle.decrypt({name:"AES-GCM",iv:bytes.slice(0,12)},await key(secret),bytes.slice(12));
    const v=JSON.parse(new TextDecoder().decode(clear)) as SearchCursor;
    if (v.binding!==binding || v.indexVersion!==indexVersion || v.rankingVersion!==V2_RANKING_VERSION ||
      !Number.isFinite(v.expires) || v.expires<=now || !Number.isFinite(Date.parse(v.snapshot)) ||
      !v.after || !Number.isFinite(v.after.score) || !Number.isFinite(v.after.date) || typeof v.after.id!=="string" ||
      !(v.vector===null || typeof v.vector==="string")) throw new InvalidSearchCursor();
    if (v.vector) unpackVector(v.vector);
    return v;
  } catch { throw new InvalidSearchCursor("search_cursor_expired_or_invalid"); }
}
