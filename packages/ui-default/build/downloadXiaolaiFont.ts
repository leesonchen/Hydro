import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import root from './utils/root';

// Version and checksum are pinned to the upstream SIL OFL 1.1 release.
export const XIAOLAI_RELEASE_URL = 'https://github.com/lxgw/kose-font/releases/download/v3.126/Xiaolai-Regular.ttf';
export const XIAOLAI_SHA256 = 'e2f68daf0e72777a8cf58bc83de1b98634b251e537ddbfca24b0ae50d1802da2';
export const XIAOLAI_SIZE = 22220806;

const asset = root('misc/fonts/Xiaolai-Regular.ttf');
const stylesheet = root('misc/xiaolai-font.generated.styl');
const fontFace = `@font-face
  font-family: "XiaoLai SC"
  font-display: swap
  src: url('./fonts/Xiaolai-Regular.ttf') format('truetype')
`;

function verified(bytes: Buffer) {
  return bytes.length === XIAOLAI_SIZE
    && createHash('sha256').update(bytes).digest('hex') === XIAOLAI_SHA256;
}

// An explicit opt-in download is supported for image builders, but an ordinary
// Hydro build must never depend on the availability of GitHub.
async function downloadFont() {
  const response = await fetch(XIAOLAI_RELEASE_URL, { signal: AbortSignal.timeout(90000) });
  if (!response.ok) throw new Error(`Cannot fetch XiaoLai font: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!verified(bytes)) throw new Error('XiaoLai font failed pinned size/SHA-256 validation');
  fs.mkdirSync(path.dirname(asset), { recursive: true });
  const temp = `${asset}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, bytes);
    fs.renameSync(temp, asset);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

export default async function prepareXiaolaiFont() {
  // Invalid local assets are rejected rather than shipped to browsers.
  if (fs.existsSync(asset) && !verified(fs.readFileSync(asset))) {
    throw new Error('Local XiaoLai font failed pinned size/SHA-256 validation');
  }

  if (!fs.existsSync(asset) && process.env.HYDRO_FETCH_XIAOLAI_FONT === '1') {
    await downloadFont();
  }

  // Stylus imports this generated file. In the absence of the optional font it
  // is deliberately empty, so normal offline builds still succeed.
  const source = fs.existsSync(asset) ? fontFace : '// XiaoLai font not bundled; use installed font or normal fallback.\n';
  if (!fs.existsSync(stylesheet) || fs.readFileSync(stylesheet, 'utf8') !== source) {
    fs.writeFileSync(stylesheet, source);
  }
}
