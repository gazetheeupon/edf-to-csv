// EDF / EDF+ / BDF / BDF+ parser (European Data Format for biosignals).
// Spec: https://www.edfplus.info/specs/edf.html and .../specs/edfplus.html
// Pure JavaScript, no dependencies. Read-only. Operates on an ArrayBuffer
// already fully loaded in memory (files are typically a few MB to a few
// hundred MB, never uploaded anywhere).

const ASCII_HEADER_BYTES = 256;

function trimAscii(bytes) {
  // Decode as latin1/ascii (EDF header is pure ASCII by spec) and trim
  // trailing spaces, which the format pads every field with.
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s.replace(/\s+$/, '');
}

function readField(view, offset, len) {
  return trimAscii(new Uint8Array(view.buffer, view.byteOffset + offset, len));
}

function parseNum(s) {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse the fixed + per-signal header of an EDF/EDF+/BDF/BDF+ file.
 * Throws a descriptive Error if the buffer does not look like a valid file.
 */
export function parseHeader(buffer) {
  if (buffer.byteLength < ASCII_HEADER_BYTES) {
    throw new Error('File is too small to be a valid EDF/BDF file.');
  }
  const bytes = new Uint8Array(buffer, 0, ASCII_HEADER_BYTES);
  const view = new DataView(buffer);

  let isBDF = false;
  if (bytes[0] === 0xff) {
    // BDF files start with byte 0xFF followed by ASCII "BIOSEMI" in the
    // remaining 7 bytes of the 8-byte "version" field.
    const rest = trimAscii(bytes.slice(1, 8));
    if (rest.indexOf('BIOSEMI') === -1) {
      throw new Error('File starts with 0xFF but is not a recognized BDF file (expected "BIOSEMI" marker).');
    }
    isBDF = true;
  } else {
    const version = readField(view, 0, 8);
    if (version !== '0') {
      throw new Error('Not an EDF/BDF file: unexpected version field "' + version + '" (expected "0").');
    }
  }

  const patientId = readField(view, 8, 80);
  const recordingId = readField(view, 88, 80);
  const startDate = readField(view, 168, 8);
  const startTime = readField(view, 176, 8);
  const headerBytes = parseNum(readField(view, 184, 8));
  const reserved44 = readField(view, 192, 44);
  const numDataRecords = parseNum(readField(view, 236, 8));
  const recordDuration = parseNum(readField(view, 244, 8));
  const ns = parseNum(readField(view, 252, 4));

  const expectedHeaderBytes = ASCII_HEADER_BYTES + ns * 256;
  if (headerBytes !== expectedHeaderBytes) {
    throw new Error(
      'Header size mismatch: file declares ' + headerBytes + ' bytes for ' + ns +
      ' signal(s), expected ' + expectedHeaderBytes + '. File may be corrupt or truncated.'
    );
  }
  if (buffer.byteLength < headerBytes) {
    throw new Error('File is truncated: header claims ' + headerBytes + ' bytes but file is only ' + buffer.byteLength + ' bytes.');
  }

  // Per-signal fields: ns consecutive fixed-width fields, one field type at
  // a time (all labels, then all transducer types, ...), NOT interleaved
  // per-signal blocks.
  let p = ASCII_HEADER_BYTES;
  const field = (len) => {
    const vals = [];
    for (let i = 0; i < ns; i++) {
      vals.push(readField(view, p + i * len, len));
    }
    p += ns * len;
    return vals;
  };

  const labels = field(16);
  const transducerTypes = field(80);
  const physicalDims = field(8);
  const physicalMins = field(8).map(parseNum);
  const physicalMaxs = field(8).map(parseNum);
  const digitalMins = field(8).map(parseNum);
  const digitalMaxs = field(8).map(parseNum);
  const prefilterings = field(80);
  const samplesPerRecord = field(8).map(parseNum);
  field(32); // reserved, per-signal

  const bytesPerSample = isBDF ? 3 : 2;
  const recordSizeBytes = samplesPerRecord.reduce((a, b) => a + b, 0) * bytesPerSample;

  // Some files (rare) legitimately have numDataRecords == -1 (unknown at
  // write time, e.g. live streaming capture). Fall back to computing it
  // from the actual file size.
  let actualNumRecords = numDataRecords;
  if (numDataRecords < 0 || recordSizeBytes === 0) {
    actualNumRecords = recordSizeBytes > 0
      ? Math.floor((buffer.byteLength - headerBytes) / recordSizeBytes)
      : 0;
  }

  const signals = [];
  for (let i = 0; i < ns; i++) {
    const physRange = physicalMaxs[i] - physicalMins[i];
    const digRange = digitalMaxs[i] - digitalMins[i];
    signals.push({
      index: i,
      label: labels[i],
      transducerType: transducerTypes[i],
      physicalDimension: physicalDims[i],
      physicalMin: physicalMins[i],
      physicalMax: physicalMaxs[i],
      digitalMin: digitalMins[i],
      digitalMax: digitalMaxs[i],
      prefiltering: prefilterings[i],
      samplesPerRecord: samplesPerRecord[i],
      sampleRate: recordDuration > 0 ? samplesPerRecord[i] / recordDuration : 0,
      isAnnotationChannel: labels[i] === 'EDF Annotations' || labels[i] === 'BDF Annotations',
      // Guard against a degenerate digital range (divide-by-zero); such a
      // channel cannot be meaningfully scaled, callers should skip it.
      scalable: digRange !== 0,
      gain: digRange !== 0 ? physRange / digRange : 0,
    });
  }

  return {
    isBDF,
    patientId,
    recordingId,
    startDate,
    startTime,
    headerBytes,
    numDataRecords: actualNumRecords,
    numDataRecordsDeclaredUnknown: numDataRecords < 0,
    recordDuration,
    ns,
    signals,
    recordSizeBytes,
    bytesPerSample,
    durationSeconds: actualNumRecords * recordDuration,
    isPlus: /EDF\+|BDF\+/.test(reserved44) || reserved44.indexOf('EDF+') === 0 || reserved44.indexOf('BDF+') === 0,
  };
}

/**
 * Read one signal's physical-unit samples across an inclusive range of data
 * records [startRecord, endRecord). Returns a Float64Array.
 */
export function readChannelSamples(buffer, header, signalIndex, startRecord, endRecord) {
  const sig = header.signals[signalIndex];
  if (!sig.scalable) {
    throw new Error('Channel "' + sig.label + '" has an identical digital min/max and cannot be scaled to physical units.');
  }
  startRecord = Math.max(0, startRecord);
  endRecord = Math.min(header.numDataRecords, endRecord);
  const nRecords = Math.max(0, endRecord - startRecord);
  const perRecord = sig.samplesPerRecord;
  const out = new Float64Array(nRecords * perRecord);

  // Byte offset within a record where this signal's samples start.
  let offsetInRecord = 0;
  for (let i = 0; i < signalIndex; i++) {
    offsetInRecord += header.signals[i].samplesPerRecord * header.bytesPerSample;
  }

  const view = new DataView(buffer);
  let outIdx = 0;
  for (let r = startRecord; r < endRecord; r++) {
    const recordStart = header.headerBytes + r * header.recordSizeBytes;
    let byteOff = recordStart + offsetInRecord;
    for (let s = 0; s < perRecord; s++) {
      let digital;
      if (header.bytesPerSample === 2) {
        digital = view.getInt16(byteOff, true);
      } else {
        // 24-bit little-endian signed integer (BDF).
        const b0 = view.getUint8(byteOff);
        const b1 = view.getUint8(byteOff + 1);
        const b2 = view.getUint8(byteOff + 2);
        let v = b0 | (b1 << 8) | (b2 << 16);
        if (v & 0x800000) v -= 0x1000000;
        digital = v;
      }
      out[outIdx++] = sig.physicalMin + (digital - sig.digitalMin) * sig.gain;
      byteOff += header.bytesPerSample;
    }
  }
  return out;
}

/**
 * Parse the TAL (Time-stamped Annotations List) records from one or more
 * "EDF Annotations" / "BDF Annotations" channels. Returns an array of
 * { onset, duration, text }.
 */
export function readAnnotations(buffer, header) {
  const annotations = [];
  const view = new DataView(buffer);
  header.signals.forEach((sig, signalIndex) => {
    if (!sig.isAnnotationChannel) return;
    let offsetInRecord = 0;
    for (let i = 0; i < signalIndex; i++) {
      offsetInRecord += header.signals[i].samplesPerRecord * header.bytesPerSample;
    }
    const perRecordBytes = sig.samplesPerRecord * header.bytesPerSample;
    for (let r = 0; r < header.numDataRecords; r++) {
      const recordStart = header.headerBytes + r * header.recordSizeBytes;
      const start = recordStart + offsetInRecord;
      const raw = new Uint8Array(buffer, start, perRecordBytes);
      let text = '';
      for (let i = 0; i < raw.length; i++) text += String.fromCharCode(raw[i]);
      // TAL: one or more "+onset[\x15duration]\x14text\x14...\x14\x00" blocks.
      const talBlocks = text.split('\x00').filter(Boolean);
      talBlocks.forEach((block) => {
        const parts = block.split('\x14');
        if (parts.length < 2) return;
        const timing = parts[0];
        const m = /^([+-][0-9.]+)(?:\x15([0-9.]+))?$/.exec(timing);
        if (!m) return;
        const onset = parseFloat(m[1]);
        const duration = m[2] !== undefined ? parseFloat(m[2]) : null;
        for (let k = 1; k < parts.length; k++) {
          const t = parts[k];
          if (t.length === 0) continue;
          annotations.push({ onset, duration, text: t });
        }
      });
    }
  });
  annotations.sort((a, b) => a.onset - b.onset);
  return annotations;
}
