'use strict';
/**
 * Watermark video (batch).
 *
 * Struktur folder:
 *   watermark.js
 *   input/       <- taruh video di sini
 *   watermark/   <- taruh logo .png / .svg di sini
 *   output/      <- hasil otomatis dibuat di sini
 *
 * Jalankan:  node watermark
 *
 * Kebutuhan: Node.js 16+, FFmpeg + ffprobe di PATH, dan `npm install` (sharp).
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

// ====================== PENGATURAN ======================
const CONFIG = {
  inputDir: path.join(__dirname, 'input'),
  watermarkDir: path.join(__dirname, 'watermark'),
  outputDir: path.join(__dirname, 'output'),

  // Isi nama file (mis. 'logo.svg') kalau di folder watermark ada lebih dari satu.
  // null = pakai file pertama (urut abjad).
  watermarkFile: null,

  // top-left | top-right | bottom-left | bottom-right | center
  position: 'top-right',
  // Ukuran & margin dihitung dari SISI TERPENDEK video, jadi hasilnya
  // konsisten di portrait maupun landscape (otomatis).
  sizePercent: 30, // lebar watermark, % dari sisi terpendek video
  marginPercent: 5, // jarak dari tepi, % dari sisi terpendek video
  opacity: 0.6, // 0 (transparan) - 1 (solid)
  crf: 18, // kualitas x264, makin kecil makin bagus (18-23 umum)
};
// ========================================================

const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v']);
const IMAGE_EXT = new Set(['.png', '.svg']);

// {m} = margin dalam pixel
const POSITIONS = {
  'top-left': 'x={m}:y={m}',
  'top-right': 'x=W-w-{m}:y={m}',
  'bottom-left': 'x={m}:y=H-h-{m}',
  'bottom-right': 'x=W-w-{m}:y=H-h-{m}',
  center: 'x=(W-w)/2:y=(H-h)/2',
};

function run(cmd, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: capture ? ['ignore', 'pipe', 'inherit'] : ['ignore', 'inherit', 'inherit'],
    });
    let out = '';
    if (capture) child.stdout.on('data', (d) => (out += d));
    child.on('error', (err) =>
      reject(
        err.code === 'ENOENT'
          ? new Error(`"${cmd}" tidak ditemukan. Install FFmpeg dan pastikan ada di PATH.`)
          : err,
      ),
    );
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} berhenti dengan kode ${code}`)),
    );
  });
}

// Ukuran video setelah rotasi (video HP sering punya metadata rotate)
async function probeSize(file) {
  const out = await run(
    'ffprobe',
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height:stream_tags=rotate:stream_side_data=rotation',
      '-of', 'json',
      file,
    ],
    { capture: true },
  );
  const stream = JSON.parse(out).streams?.[0];
  if (!stream) throw new Error('Tidak ada stream video di file ini');

  const rotation = Number(
    stream.tags?.rotate ?? stream.side_data_list?.find((d) => 'rotation' in d)?.rotation ?? 0,
  );
  const swap = Math.abs(rotation) % 180 === 90;
  return swap
    ? { width: stream.height, height: stream.width }
    : { width: stream.width, height: stream.height };
}

// Durasi video dalam detik (null kalau tidak diketahui)
async function probeDuration(file) {
  try {
    const out = await run(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { capture: true },
    );
    const sec = parseFloat(out.trim());
    return Number.isFinite(sec) && sec > 0 ? sec : null;
  } catch {
    return null;
  }
}

// Jalankan ffmpeg dan laporkan progress lewat callback onProgress({ seconds, speed, done })
function runFfmpeg(args, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-progress', 'pipe:1', '-nostats', ...args], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    let buffer = '';
    let state = {};
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const raw of lines) {
        const line = raw.trim();
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq);
        const value = line.slice(eq + 1);
        state[key] = value;

        if (key === 'progress') {
          const us = Number(state.out_time_us ?? state.out_time_ms);
          onProgress({
            seconds: Number.isFinite(us) && us >= 0 ? us / 1e6 : null,
            speed: state.speed && state.speed !== 'N/A' ? state.speed.trim() : '',
            done: value === 'end',
          });
          state = {};
        }
      }
    });

    child.on('error', (err) =>
      reject(
        err.code === 'ENOENT'
          ? new Error('"ffmpeg" tidak ditemukan. Install FFmpeg dan pastikan ada di PATH.')
          : err,
      ),
    );
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg berhenti dengan kode ${code}`)),
    );
  });
}

function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '--:--';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Progress bar satu baris: per video + total keseluruhan
function createProgressBar({ index, total, duration }) {
  const isTTY = Boolean(process.stdout.isTTY);
  const started = Date.now();
  const width = 28;
  let lastStep = -1;
  let lastSpeed = '';
  let drawn = false;

  const draw = (frac, speed, final = false) => {
    const elapsed = (Date.now() - started) / 1000;
    let line;

    if (frac === null) {
      // durasi tidak diketahui -> tampilkan waktu berjalan saja
      line = `  memproses... ${formatTime(elapsed)}  ${speed}`;
    } else {
      const pct = Math.min(100, Math.max(0, frac * 100));
      const filled = Math.round((pct / 100) * width);
      const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
      const eta = final ? 0 : frac > 0.01 ? elapsed / frac - elapsed : NaN;
      const overall = ((index + frac) / total) * 100;
      line =
        `  ${bar} ${pct.toFixed(1).padStart(5)}%` +
        `  ETA ${formatTime(eta)}` +
        `  ${speed.padEnd(7)}` +
        `  | Total ${overall.toFixed(0)}%`;
    }

    if (isTTY) {
      process.stdout.write(`\r${line}\x1b[K${final ? '\n' : ''}`);
      drawn = !final;
    } else if (frac !== null) {
      // bukan terminal interaktif (mis. dialihkan ke file): cetak tiap 10%
      const step = final ? 10 : Math.floor(frac * 10);
      if (step !== lastStep) {
        lastStep = step;
        console.log(line);
      }
    }
  };

  return {
    update({ seconds, speed, done }) {
      if (speed) lastSpeed = speed;
      const frac = done
        ? 1
        : duration && seconds !== null
          ? Math.min(seconds / duration, 1)
          : null;
      draw(frac, speed, false);
    },
    finish() {
      draw(duration ? 1 : null, lastSpeed, true);
    },
    abort() {
      if (isTTY && drawn) process.stdout.write('\n');
      drawn = false;
    },
  };
}

async function listFiles(dir, allowedExt) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && allowedExt.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort();
}

async function main() {
  const posTemplate = POSITIONS[CONFIG.position];
  if (!posTemplate) throw new Error(`Posisi tidak valid: ${CONFIG.position}`);
  if (!(CONFIG.opacity >= 0 && CONFIG.opacity <= 1)) throw new Error('opacity harus 0-1');
  if (!(CONFIG.sizePercent > 0 && CONFIG.sizePercent <= 100)) throw new Error('sizePercent harus 1-100');

  // Pastikan folder ada
  for (const dir of [CONFIG.inputDir, CONFIG.watermarkDir, CONFIG.outputDir]) {
    await fs.mkdir(dir, { recursive: true });
  }

  // Cari watermark
  const wmFiles = await listFiles(CONFIG.watermarkDir, IMAGE_EXT);
  if (wmFiles.length === 0) {
    throw new Error('Tidak ada file .png / .svg di folder "watermark".');
  }
  const wmName = CONFIG.watermarkFile ?? wmFiles[0];
  if (!wmFiles.includes(wmName)) {
    throw new Error(`File watermark "${wmName}" tidak ditemukan di folder "watermark".`);
  }
  if (wmFiles.length > 1 && !CONFIG.watermarkFile) {
    console.log(`Ada ${wmFiles.length} file watermark, memakai: ${wmName}`);
  }

  // Cari video
  const videos = await listFiles(CONFIG.inputDir, VIDEO_EXT);
  if (videos.length === 0) {
    throw new Error('Tidak ada video di folder "input".');
  }

  // Render watermark (PNG/SVG) jadi PNG transparan sekali saja
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wm-'));
  const wmPng = path.join(tmpDir, 'watermark.png');

  try {
    await sharp(path.join(CONFIG.watermarkDir, wmName), { density: 300 })
      .resize({ width: 1024, withoutEnlargement: true })
      .png()
      .toFile(wmPng);

    console.log(`Memproses ${videos.length} video dengan watermark "${wmName}"\n`);
    let ok = 0;
    const failed = [];

    for (const [idx, name] of videos.entries()) {
      const inFile = path.join(CONFIG.inputDir, name);
      const outFile = path.join(CONFIG.outputDir, `${path.parse(name).name}.mp4`);
      console.log(`[${idx + 1}/${videos.length}] ${name}`);
      let bar = null;

      try {
        const { width, height } = await probeSize(inFile);
        const base = Math.min(width, height); // portrait -> lebar, landscape -> tinggi
        const wmWidth = Math.max(2, Math.round((base * CONFIG.sizePercent) / 100));
        const margin = Math.round((base * CONFIG.marginPercent) / 100);
        const pos = posTemplate.replaceAll('{m}', String(margin));

        const filter =
          `[1:v]scale=${wmWidth}:-1,format=rgba,colorchannelmixer=aa=${CONFIG.opacity}[wm];` +
          `[0:v][wm]overlay=${pos}:format=auto,format=yuv420p[v]`;

        const duration = await probeDuration(inFile);
        bar = createProgressBar({ index: idx, total: videos.length, duration });

        await runFfmpeg(
          [
            '-y', '-hide_banner', '-loglevel', 'error',
            '-i', inFile,
            '-i', wmPng,
            '-filter_complex', filter,
            '-map', '[v]',
            '-map', '0:a?',
            '-c:v', 'libx264',
            '-preset', 'medium',
            '-crf', String(CONFIG.crf),
            '-c:a', 'aac',
            '-b:a', '192k',
            '-movflags', '+faststart',
            outFile,
          ],
          bar.update,
        );
        bar.finish();
        ok++;
      } catch (err) {
        bar?.abort();
        console.error(`  Gagal: ${err.message}`);
        failed.push(name);
      }
    }

    console.log(`\nSelesai: ${ok} berhasil, ${failed.length} gagal. Hasil ada di folder "output".`);
    if (failed.length) console.log('Gagal:', failed.join(', '));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});