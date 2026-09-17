// Minimal GRIB2 (WMO binary meteorological format) parser, scoped to
// exactly what BSH's current-forecast files need: a regular lat/lon grid
// (Grid Definition Template 3.0) and simple-packed grid-point data (Data
// Representation Template 5.0) — the two most common, simplest GRIB2
// encodings. Deliberately does NOT attempt JPEG2000 (5.40), PNG (5.41), or
// complex packing (5.2/5.3): those need real third-party decoders this
// project (no build step, no backend) can't safely bundle blind, and a
// half-working decoder for those would silently produce wrong current
// data fed straight into the routing solver — far worse than refusing.
// Any unsupported template throws a specific, named error instead of
// guessing, so a real-world mismatch surfaces as "unsupported X" rather
// than corrupted numbers.
//
// A GRIB2 *file* is one or more back-to-back *messages*, each self-
// contained: "GRIB" indicator, then numbered sections (1, optionally 2,
// 3, 4, 5, optionally 6, 7), then a literal "7777" end marker. BSH's
// current files are expected to hold one message per (parameter ×
// forecast-time) pair — e.g. one for the U component at t=0, one for V
// at t=0, one for U at t=+15min, etc.
//
// Verified against hand-built synthetic GRIB2 fixtures with known
// section bytes and hand-computed expected grids (covering the grid-
// definition/product-definition/simple-packing sections, the sign-bit
// integer convention for both 2- and 4-byte fields, and the zero-bit
// degenerate packing case) — this project's sandbox can't reach
// filebox.bsh.de to test against a real file, so this is the best
// available verification. See the README for what remains unverified.

const GRIB_MAGIC = 0x47524942; // "GRIB"
const END_MAGIC = 0x37373737; // "7777"

function readUint32BE(view, offset) { return view.getUint32(offset, false); }
function readUint16BE(view, offset) { return view.getUint16(offset, false); }
function readUint8(view, offset) { return view.getUint8(offset); }

// GRIB2's own signed-integer convention (WMO Regulation 92.1.4): the
// high-order bit of the field is a sign flag, NOT two's complement.
// Applies throughout the format (grid lat/lon, scale factors, etc).
function readSignedGrib(view, offset, numBytes) {
  let raw = 0;
  for (let i = 0; i < numBytes; i++) raw = raw * 256 + view.getUint8(offset + i);
  const signBit = 1 << (numBytes * 8 - 1);
  // >>> 0 style masks aren't safe above 32 bits; numBytes is always <=4 here.
  if (numBytes === 4) {
    const topByte = view.getUint8(offset);
    if (topByte & 0x80) return -(raw & 0x7fffffff);
    return raw;
  }
  if (raw & signBit) return -(raw & (signBit - 1));
  return raw;
}

function findNextMessageStart(view, from) {
  for (let i = from; i <= view.byteLength - 4; i++) {
    if (readUint32BE(view, i) === GRIB_MAGIC) return i;
  }
  return -1;
}

// Parses one message's fixed-structure sections (0, 1, 3, 4, 5, 6) into
// lightweight metadata WITHOUT unpacking section 7's actual data values —
// that unpacking is comparatively expensive and, for a multi-day/multi-
// parameter file, wasteful to do eagerly for every message when a caller
// typically only ever needs a handful of (parameter, time) combinations.
// Section 2 (local use) is skipped if present but never relied on.
function parseMessageHeader(view, msgStart) {
  if (readUint32BE(view, msgStart) !== GRIB_MAGIC) {
    throw new Error(`GRIB2 parse: expected "GRIB" magic at offset ${msgStart}`);
  }
  const discipline = readUint8(view, msgStart + 6);
  const edition = readUint8(view, msgStart + 7);
  if (edition !== 2) throw new Error(`GRIB2 parse: unsupported edition ${edition} (only GRIB2 is supported)`);
  // Octets 9-16 are a 64-bit total message length; real messages here are
  // always far below 2^32 octets, so the low 32 bits are sufficient.
  const totalLength = readUint32BE(view, msgStart + 12);
  if (totalLength <= 0 || msgStart + totalLength > view.byteLength) {
    throw new Error('GRIB2 parse: message length section 0 declares runs past end of buffer');
  }

  let offset = msgStart + 16; // end of section 0
  const meta = { msgStart, msgLength: totalLength, discipline };

  while (offset < msgStart + totalLength) {
    // The end section is exactly "7777" (no length prefix) and always
    // the last 4 bytes of the message.
    if (readUint32BE(view, offset) === END_MAGIC) break;

    const sectionLength = readUint32BE(view, offset);
    const sectionNumber = readUint8(view, offset + 4);
    if (sectionLength <= 0) throw new Error(`GRIB2 parse: zero-length section ${sectionNumber} at offset ${offset}`);

    if (sectionNumber === 1) {
      meta.refYear = readUint16BE(view, offset + 12);
      meta.refMonth = readUint8(view, offset + 14);
      meta.refDay = readUint8(view, offset + 15);
      meta.refHour = readUint8(view, offset + 16);
      meta.refMinute = readUint8(view, offset + 17);
      meta.refSecond = readUint8(view, offset + 18);
    } else if (sectionNumber === 3) {
      const gridDefTemplate = readUint16BE(view, offset + 12);
      if (gridDefTemplate !== 0) {
        throw new Error(`GRIB2 parse: unsupported grid definition template 3.${gridDefTemplate} (only 3.0, regular lat/lon, is supported)`);
      }
      const base = offset + 14; // start of template 3.0 data
      meta.nx = readUint32BE(view, base + 16);
      meta.ny = readUint32BE(view, base + 20);
      meta.lat1 = readSignedGrib(view, base + 32, 4) / 1e6;
      meta.lon1 = readSignedGrib(view, base + 36, 4) / 1e6;
      const resFlags = readUint8(view, base + 40);
      meta.lat2 = readSignedGrib(view, base + 41, 4) / 1e6;
      meta.lon2 = readSignedGrib(view, base + 45, 4) / 1e6;
      meta.di = readUint32BE(view, base + 49) / 1e6;
      meta.dj = readUint32BE(view, base + 53) / 1e6;
      meta.scanMode = readUint8(view, base + 57);
      if (meta.scanMode !== 0x00) {
        throw new Error(`GRIB2 parse: unsupported scanning mode 0x${meta.scanMode.toString(16)} (only the default west→east, north→south row-major scan is supported)`);
      }
      void resFlags;
    } else if (sectionNumber === 4) {
      const pdTemplate = readUint16BE(view, offset + 7);
      if (pdTemplate !== 0) {
        throw new Error(`GRIB2 parse: unsupported product definition template 4.${pdTemplate} (only 4.0, point-in-time forecast, is supported)`);
      }
      const base = offset + 9; // start of template 4.0 data
      meta.paramCategory = readUint8(view, base);
      meta.paramNumber = readUint8(view, base + 1);
      const timeUnit = readUint8(view, base + 8);
      const forecastTimeRaw = readUint32BE(view, base + 9);
      // Unit indicator 0 = minute, 1 = hour (WMO code table 4.4) — the two
      // units BSH's 15-minute-resolution product would plausibly use.
      if (timeUnit !== 0 && timeUnit !== 1) {
        throw new Error(`GRIB2 parse: unsupported forecast time unit indicator ${timeUnit} (only minutes/hours supported)`);
      }
      meta.forecastMinutes = timeUnit === 0 ? forecastTimeRaw : forecastTimeRaw * 60;
    } else if (sectionNumber === 5) {
      meta.numDataPoints = readUint32BE(view, offset + 5);
      const drTemplate = readUint16BE(view, offset + 9);
      if (drTemplate !== 0) {
        throw new Error(`GRIB2 parse: unsupported data representation template 5.${drTemplate} (only 5.0, simple packing, is supported)`);
      }
      const base = offset + 11; // start of template 5.0 data
      meta.refValue = view.getFloat32(base, false);
      meta.binaryScale = readSignedGrib(view, base + 4, 2);
      meta.decimalScale = readSignedGrib(view, base + 6, 2);
      meta.numBits = readUint8(view, base + 8);
    } else if (sectionNumber === 6) {
      const bitmapIndicator = readUint8(view, offset + 5);
      meta.hasBitmap = bitmapIndicator === 0;
      meta.bitmapOffset = offset + 6;
    } else if (sectionNumber === 7) {
      meta.dataOffset = offset + 5;
      meta.dataLength = sectionLength - 5;
    }

    offset += sectionLength;
  }

  if (meta.nx == null || meta.refValue === undefined || meta.dataOffset == null) {
    throw new Error('GRIB2 parse: message is missing a required section (3, 5, or 7)');
  }
  return meta;
}

// Scans an entire GRIB2 file buffer and returns an array of per-message
// metadata (see parseMessageHeader) — cheap: does not unpack any actual
// grid values. Throws on the first message it can't safely interpret
// (see module doc for why "throw, don't guess" is the right default
// here): a corrupt or unsupported message makes every message after it
// unreliable to locate too, since section lengths are how this scan
// finds the next message boundary.
export function indexGrib2File(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const messages = [];
  let offset = 0;
  while (offset < view.byteLength - 4) {
    const start = findNextMessageStart(view, offset);
    if (start === -1) break;
    const meta = parseMessageHeader(view, start);
    messages.push(meta);
    offset = start + meta.msgLength;
  }
  return messages;
}

// Unpacks one message's section 7 data into a Float32Array of nx*ny grid
// values, row-major, first row = northernmost (per the scan mode this
// parser requires — see parseMessageHeader). A bitmap-flagged point that
// isn't set gets NaN instead of a decoded value (BSH's marine grids
// plausibly mask out land cells this way).
export function decodeGrib2Grid(arrayBuffer, meta) {
  const view = new DataView(arrayBuffer);
  const total = meta.nx * meta.ny;
  const out = new Float32Array(total);

  let bitmap = null;
  if (meta.hasBitmap) {
    bitmap = new Uint8Array(total);
    for (let i = 0; i < total; i++) {
      const byteIdx = meta.bitmapOffset + (i >> 3);
      const bit = 7 - (i & 7);
      bitmap[i] = (view.getUint8(byteIdx) >> bit) & 1;
    }
  }

  const nbits = meta.numBits;
  const scale = Math.pow(2, meta.binaryScale) / Math.pow(10, meta.decimalScale);
  const refOverScale = meta.refValue / Math.pow(10, meta.decimalScale);

  if (nbits === 0) {
    // All points share the reference value (a degenerate but valid
    // simple-packing case — zero bits per value, nothing stored).
    out.fill(refOverScale);
  } else {
    let bitPos = 0;
    const dataOffset = meta.dataOffset;
    for (let i = 0; i < total; i++) {
      if (bitmap && bitmap[i] === 0) { out[i] = NaN; continue; }
      let raw = 0;
      for (let b = 0; b < nbits; b++) {
        const bytePos = dataOffset + ((bitPos + b) >> 3);
        const bitInByte = 7 - ((bitPos + b) & 7);
        raw = raw * 2 + ((view.getUint8(bytePos) >> bitInByte) & 1);
      }
      bitPos += nbits;
      out[i] = refOverScale + raw * scale;
    }
  }
  return out;
}

export function messageRefTime(meta) {
  return new Date(Date.UTC(meta.refYear, meta.refMonth - 1, meta.refDay, meta.refHour, meta.refMinute, meta.refSecond));
}

export function messageValidTime(meta) {
  return new Date(messageRefTime(meta).getTime() + meta.forecastMinutes * 60000);
}
