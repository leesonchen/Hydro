import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import root from './utils/root';

// SIL OFL 1.1: https://github.com/lxgw/kose-font/blob/master/OFL.txt
// Pin the release and hash so the generated UI does not depend on external fonts.
export const XIAOLAI_RELEASE_URL = 'https://github.com/lxgw/kose-font/releases/download/v3.126/Xiaolai-Regular.ttf';
export const XIAOLAI_SHA256 = 'e2f68daf0e72777a8cf58bc83de1b98634b251e537ddbfca24b0ae50d1802da2';
export const XIAOLAI_SIZE = 22220806;

export default async function ensureXiaolaiFont() {
  const destination = root('misc/fonts/Xiaolai-Regular.ttf');
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  if (fs.existsSync(destination)) {
    const existing = fs.readFileSync(destination);
    if (existing.length === XIAOLAI_SIZE && digest(existing) === XIAOLAI_SHA256) return;
  }
  const response = await fetch(XIAOLAI_RELEASE_URL, { signal: AbortSignal.timeout(90000) });
  if (!response.ok) throw new Error(`Could not download XiaoLai font (HTTP ${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== XIAOLAI_SIZE || digest(bytes) !== XIAOLAI_SHA256) {
    throw new Error('XiaoLai font size/checksum mismatch; refusing to package unverified font');
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes);
    fs.renameSync(temporary, destination);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
