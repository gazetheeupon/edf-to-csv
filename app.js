import { parseHeader, readChannelSamples, readAnnotations } from './edf-parser.js';

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const fnameEl = document.getElementById('fname');
const statusEl = document.getElementById('status');
const metaCard = document.getElementById('metaCard');
const metaGrid = document.getElementById('metaGrid');
const channelsCard = document.getElementById('channelsCard');
const channelsBody = document.getElementById('channelsBody');
const rangeStart = document.getElementById('rangeStart');
const rangeEnd = document.getElementById('rangeEnd');
const durationHint = document.getElementById('durationHint');
const exportBtn = document.getElementById('exportBtn');
const exportAnnotBtn = document.getElementById('exportAnnotBtn');
const exportStatus = document.getElementById('exportStatus');

const MAX_CSV_CELLS = 8_000_000; // ~ a few hundred MB of CSV text; warn above this

let currentBuffer = null;
let currentHeader = null;
let currentAnnotations = null;

function setStatus(msg, isError) {
  statusEl.textContent = msg || '';
  statusEl.className = isError ? 'error' : '';
}

function resetResults() {
  metaCard.style.display = 'none';
  channelsCard.style.display = 'none';
  exportStatus.textContent = '';
  exportStatus.className = '';
  currentBuffer = null;
  currentHeader = null;
  currentAnnotations = null;
}

function fmtMeta(label, value) {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value;
  metaGrid.appendChild(dt);
  metaGrid.appendChild(dd);
}

function renderMeta(header) {
  metaGrid.innerHTML = '';
  fmtMeta('Format', header.isBDF ? (header.isPlus ? 'BDF+' : 'BDF') : (header.isPlus ? 'EDF+' : 'EDF'));
  fmtMeta('Patient', header.patientId || '(none)');
  fmtMeta('Recording', header.recordingId || '(none)');
  fmtMeta('Start date/time', (header.startDate || '?') + ' ' + (header.startTime || ''));
  fmtMeta('Duration', header.durationSeconds.toFixed(3) + ' s (' + header.numDataRecords + ' × ' + header.recordDuration + 's records)' + (header.numDataRecordsDeclaredUnknown ? ' — record count was unknown in file, computed from file size' : ''));
  fmtMeta('Signals', String(header.ns));
  metaCard.style.display = '';
}

function renderChannels(header, annotations) {
  channelsBody.innerHTML = '';
  header.signals.forEach((sig) => {
    const tr = document.createElement('tr');
    if (sig.isAnnotationChannel) {
      tr.className = 'annot-row';
      tr.innerHTML =
        '<td></td><td>' + escapeHtml(sig.label) + '</td>' +
        '<td colspan="4">Annotations channel' + (annotations.length ? ' — ' + annotations.length + ' event(s) found' : ' — no events found') + '</td>';
    } else {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'chan-cb';
      cb.dataset.index = String(sig.index);
      cb.disabled = !sig.scalable;
      const td0 = document.createElement('td');
      td0.appendChild(cb);
      tr.appendChild(td0);
      const rangeTxt = sig.physicalMin + '..' + sig.physicalMax + (sig.physicalDimension ? ' ' + sig.physicalDimension : '');
      const rest = document.createElement('td');
      rest.colSpan = 0;
      tr.insertAdjacentHTML('beforeend',
        '<td>' + escapeHtml(sig.label) + '</td>' +
        '<td>' + (sig.sampleRate ? sig.sampleRate.toFixed(2) : '?') + '</td>' +
        '<td>' + escapeHtml(sig.physicalDimension || '') + '</td>' +
        '<td>' + escapeHtml(rangeTxt) + (sig.scalable ? '' : ' (unscalable)') + '</td>' +
        '<td>' + escapeHtml(sig.prefiltering || '') + '</td>'
      );
      cb.addEventListener('change', updateExportState);
    }
    channelsBody.appendChild(tr);
  });

  rangeStart.value = '0';
  rangeEnd.value = header.durationSeconds.toString();
  durationHint.textContent = '(full recording: 0 to ' + header.durationSeconds.toFixed(3) + ' s)';

  exportAnnotBtn.style.display = annotations.length ? '' : 'none';
  channelsCard.style.display = '';
  updateExportState();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function selectedChannelIndices() {
  return Array.from(channelsBody.querySelectorAll('.chan-cb:checked')).map((cb) => parseInt(cb.dataset.index, 10));
}

function updateExportState() {
  const indices = selectedChannelIndices();
  exportStatus.className = '';
  if (indices.length === 0) {
    exportBtn.disabled = true;
    exportStatus.textContent = '';
    return;
  }
  const rates = indices.map((i) => currentHeader.signals[i].sampleRate);
  const allSame = rates.every((r) => r === rates[0]);
  if (!allSame) {
    exportBtn.disabled = true;
    exportStatus.textContent = 'Selected channels have different sample rates (' + rates.join(', ') + ' Hz). Select channels that share a rate, or export them separately.';
    exportStatus.className = 'warn';
    return;
  }
  exportBtn.disabled = false;
  exportStatus.textContent = '';
}

function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function doExport() {
  const indices = selectedChannelIndices();
  if (indices.length === 0) return;

  let start = parseFloat(rangeStart.value);
  let end = parseFloat(rangeEnd.value);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    exportStatus.textContent = 'Enter a valid time range (start >= 0, end > start).';
    exportStatus.className = 'warn';
    return;
  }
  end = Math.min(end, currentHeader.durationSeconds);

  const recordDuration = currentHeader.recordDuration;
  const startRecord = Math.floor(start / recordDuration);
  const endRecord = Math.ceil(end / recordDuration);
  const sampleRate = currentHeader.signals[indices[0]].sampleRate;

  const estimatedCells = (endRecord - startRecord) * currentHeader.signals[indices[0]].samplesPerRecord * (indices.length + 1);
  if (estimatedCells > MAX_CSV_CELLS) {
    const proceed = window.confirm(
      'This range would produce roughly ' + estimatedCells.toLocaleString() +
      ' CSV cells, which may be slow or use a lot of memory. Narrow the time range first, or click OK to try anyway.'
    );
    if (!proceed) return;
  }

  exportStatus.textContent = 'Building CSV…';
  exportStatus.className = '';

  // Defer to let the status message paint before the (synchronous, possibly
  // large) CSV build runs.
  setTimeout(() => {
    try {
      const channelData = indices.map((i) => readChannelSamples(currentBuffer, currentHeader, i, startRecord, endRecord));
      const n = channelData[0].length;
      const recordStartOffset = startRecord * recordDuration;
      const lines = new Array(n + 1);
      const header = ['time_s'].concat(indices.map((i) => csvEscape(currentHeader.signals[i].label + (currentHeader.signals[i].physicalDimension ? ' (' + currentHeader.signals[i].physicalDimension + ')' : ''))));
      lines[0] = header.join(',');
      for (let s = 0; s < n; s++) {
        const t = recordStartOffset + s / sampleRate;
        const row = [t.toFixed(6)];
        for (let c = 0; c < channelData.length; c++) row.push(channelData[c][s]);
        lines[s + 1] = row.join(',');
      }
      const csv = lines.join('\n') + '\n';
      downloadBlob(csv, 'edf_export.csv', 'text/csv');
      exportStatus.textContent = 'Exported ' + n + ' rows × ' + indices.length + ' channel(s).';
      exportStatus.className = '';
    } catch (e) {
      exportStatus.textContent = 'Export failed: ' + e.message;
      exportStatus.className = 'warn';
    }
  }, 10);
}

function csvEscape(s) {
  s = String(s);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function exportAnnotations() {
  if (!currentAnnotations || currentAnnotations.length === 0) return;
  const lines = ['onset_s,duration_s,text'];
  currentAnnotations.forEach((a) => {
    lines.push([a.onset.toFixed(6), a.duration === null ? '' : a.duration.toFixed(6), csvEscape(a.text)].join(','));
  });
  downloadBlob(lines.join('\n') + '\n', 'edf_annotations.csv', 'text/csv');
}

async function handleFile(file) {
  resetResults();
  fnameEl.textContent = file.name + ' (' + (file.size / 1024).toFixed(1) + ' KB)';
  setStatus('Reading file…');
  try {
    const buffer = await file.arrayBuffer();
    const header = parseHeader(buffer);
    const annotations = readAnnotations(buffer, header);
    currentBuffer = buffer;
    currentHeader = header;
    currentAnnotations = annotations;
    setStatus('');
    renderMeta(header);
    renderChannels(header, annotations);
  } catch (e) {
    setStatus(e.message || 'Could not parse this file.', true);
  }
}

dropzone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});
['dragenter', 'dragover'].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add('drag');
  });
});
['dragleave', 'drop'].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag');
  });
});
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

exportBtn.addEventListener('click', doExport);
exportAnnotBtn.addEventListener('click', exportAnnotations);
