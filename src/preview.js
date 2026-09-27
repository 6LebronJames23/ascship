// App Preview video checks. Reads the MP4/MOV box structure directly, so no
// ffmpeg is needed: track types, duration, frame rate and dimensions.
import { openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { basename } from 'node:path';

const check = (status, id, message, extra = {}) => ({ status, id, message, ...extra });

// Sizes App Store Connect accepts for App Previews (portrait and landscape).
export const KNOWN_SIZES = new Set(['886x1920', '1080x1920', '1200x1600', '900x1200'].flatMap((s) => {
  const [w, h] = s.split('x');
  return [s, `${h}x${w}`];
}));

function* boxes(buf, start = 0, end = buf.length) {
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    let header = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(off + 8)); header = 16; }
    else if (size === 0) size = end - off;
    if (size < header || off + size > end) return;
    yield { type, start: off + header, end: off + size };
    off += size;
  }
}
const child = (buf, box, type) => [...boxes(buf, box.start, box.end)].find((b) => b.type === type);

// Only the moov box is read into memory; mdat (the video data) is skipped.
function readMoov(path) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const head = Buffer.alloc(16);
    let off = 0;
    while (off + 8 <= size) {
      readSync(fd, head, 0, 16, off);
      let boxSize = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (boxSize === 1) boxSize = Number(head.readBigUInt64BE(8));
      else if (boxSize === 0) boxSize = size - off;
      if (boxSize < 8) break;
      if (type === 'moov') {
        const buf = Buffer.alloc(boxSize);
        readSync(fd, buf, 0, boxSize, off);
        return buf;
      }
      off += boxSize;
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

const fullBoxTime = (buf, box) => {
  const v = buf[box.start];
  return v === 1
    ? { timescale: buf.readUInt32BE(box.start + 20), duration: Number(buf.readBigUInt64BE(box.start + 24)) }
    : { timescale: buf.readUInt32BE(box.start + 12), duration: buf.readUInt32BE(box.start + 16) };
};

export function probeVideo(path) {
  const buf = readMoov(path);
  if (!buf) throw new Error(`${basename(path)} is not an MP4/MOV file (no moov box)`);
  const moov = { start: 8, end: buf.length };
  const mvhd = child(buf, moov, 'mvhd');
  const movie = mvhd ? fullBoxTime(buf, mvhd) : { timescale: 1, duration: 0 };
  const tracks = [];
  for (const trak of boxes(buf, moov.start, moov.end)) {
    if (trak.type !== 'trak') continue;
    const mdia = child(buf, trak, 'mdia');
    const hdlr = mdia && child(buf, mdia, 'hdlr');
    const mdhd = mdia && child(buf, mdia, 'mdhd');
    const tkhd = child(buf, trak, 'tkhd');
    if (!hdlr) continue;
    const handler = buf.toString('latin1', hdlr.start + 8, hdlr.start + 12);
    const t = { handler };
    if (tkhd) {
      t.width = Math.round(buf.readUInt32BE(tkhd.end - 8) / 65536);
      t.height = Math.round(buf.readUInt32BE(tkhd.end - 4) / 65536);
    }
    if (mdhd) {
      const { timescale, duration } = fullBoxTime(buf, mdhd);
      t.seconds = duration / timescale;
      const stts = child(buf, child(buf, child(buf, mdia, 'minf') ?? mdia, 'stbl') ?? mdia, 'stts');
      if (stts && handler === 'vide' && t.seconds > 0) {
        let samples = 0;
        const n = buf.readUInt32BE(stts.start + 4);
        for (let i = 0; i < n; i++) samples += buf.readUInt32BE(stts.start + 8 + i * 8);
        t.fps = samples / t.seconds;
      }
    }
    tracks.push(t);
  }
  return { seconds: movie.duration / movie.timescale, tracks };
}

export function checkPreview(info) {
  const out = [];
  const video = info.tracks.find((t) => t.handler === 'vide');
  const audio = info.tracks.some((t) => t.handler === 'soun');
  if (!video) return [check('fail', 'preview.no-video', 'no video track')];

  const size = `${video.width}x${video.height}`;
  out.push(KNOWN_SIZES.has(size)
    ? check('pass', 'preview.size', `${video.width}×${video.height}`)
    : check('warn', 'preview.size', `${video.width}×${video.height} is not an App Preview size ascship knows (e.g. 886×1920, 1080×1920, 1200×1600)`, {
      hint: 'Screen recordings at native device resolution are usually rejected; scale to the preview size for that display.',
    }));

  // The video track is what plays; the movie header can include edit-list padding.
  const s = video.seconds ?? info.seconds;
  out.push(s >= 15 && s <= 30
    ? check('pass', 'preview.duration', `${s.toFixed(1)}s`)
    : check('fail', 'preview.duration', `${s.toFixed(1)}s long; App Previews must be 15–30 seconds`));

  if (video.fps !== undefined) {
    out.push(video.fps <= 30.5
      ? check('pass', 'preview.fps', `${Math.round(video.fps)} fps`)
      : check('fail', 'preview.fps', `${Math.round(video.fps)} fps; App Previews are limited to 30 fps`));
  }

  out.push(audio
    ? check('pass', 'preview.audio', 'has an audio track')
    : check('fail', 'preview.no-audio', 'no audio track; App Store Connect rejects previews without one, even a silent one', {
      hint: 'Add a silent track: ffmpeg -i in.mp4 -f lavfi -i anullsrc=r=44100:cl=stereo -shortest -c:v copy -c:a aac out.mp4',
    }));
  return out;
}
