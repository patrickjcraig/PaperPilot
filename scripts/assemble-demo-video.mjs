#!/usr/bin/env node
// Assemble real captured PNG/JPEG frames only. This script never generates browser UI.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const SCENE_SECONDS = Object.freeze([15, 18, 20, 22, 22, 18, 14.5, 20.5]);
export const TOTAL_SECONDS = 150;
const MAX_FRAMES = 10_000;
const FOOTER_HEIGHT = 100;
const DISCLOSURE = 'Edited live capture · timing compressed · synthetic narration';
const PUBLIC_LINKS = 'patrickjcraig.github.io/PaperPilot/webmcp/  ·  github.com/patrickjcraig/PaperPilot';
const fail = message => { throw new Error(message); };
const finite = value => typeof value === 'number' && Number.isFinite(value);
const cleanPath = value => typeof value === 'string' && value.length > 0 && !/[\x00-\x1f]/.test(value);

export function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--overwrite') { if (options.overwrite) fail('Duplicate --overwrite.'); options.overwrite = true; continue; }
    if (!['--capture', '--audio-dir', '--output', '--ffmpeg', '--ffprobe'].includes(arg)) fail(`Unknown option: ${arg}`);
    const key = arg.slice(2);
    if (Object.hasOwn(options, key) || !cleanPath(argv[index + 1]) || argv[index + 1].startsWith('--')) fail(`Missing or duplicate ${arg}.`);
    options[key] = path.resolve(argv[++index]);
  }
  for (const key of ['capture', 'audio-dir', 'output', 'ffmpeg', 'ffprobe']) if (!options[key]) fail(`Required: --${key}`);
  if (path.extname(options.output).toLowerCase() !== '.mp4') fail('Output must be an MP4 file.');
  return options;
}

export function validateCapture(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || !Number.isInteger(manifest.width) || !Number.isInteger(manifest.height) || manifest.width < 320 || manifest.height < 180 || manifest.width > 3840 || manifest.height > 2160) fail('Capture must use schemaVersion 1 and bounded real-frame dimensions.');
  if (!/^[a-f0-9]{40}$/i.test(manifest.sourceCommit) || !/^[a-f0-9]{64}$/i.test(manifest.releaseFingerprint)) fail('Capture release identity is missing or malformed.');
  if (!Array.isArray(manifest.frames) || manifest.frames.length < 8 || manifest.frames.length > MAX_FRAMES) fail('Capture needs 8 to 10000 frames.');
  if (!Array.isArray(manifest.scenes) || manifest.scenes.length !== 8) fail('Capture needs exactly eight scenes.');
  let previousEnd = -1;
  manifest.scenes.forEach((scene, index) => {
    if (!scene || scene.id !== index + 1 || !finite(scene.startMs) || !finite(scene.endMs) || scene.startMs < 0 || scene.endMs <= scene.startMs || scene.startMs < previousEnd) fail('Scenes must be numbered 1..8 with non-overlapping chronological bounds.');
    previousEnd = scene.endMs;
  });
  let previousTimestamp = -1;
  let previousScene = 1;
  const counts = Array(8).fill(0);
  const names = new Set();
  for (const frame of manifest.frames) {
    if (!frame || !Number.isInteger(frame.scene) || frame.scene < previousScene || frame.scene > 8 || !finite(frame.timestampMs) || frame.timestampMs <= previousTimestamp || !cleanPath(frame.file) || !path.isAbsolute(frame.file)) fail('Frames must be absolute image paths in original timestamp and scene order.');
    const scene = manifest.scenes[frame.scene - 1];
    if (frame.timestampMs < scene.startMs || frame.timestampMs > scene.endMs) fail('Frame timestamp is outside its scene.');
    const name = path.resolve(frame.file).toLowerCase();
    if (names.has(name)) fail('Each captured frame must have a distinct file.');
    names.add(name);
    counts[frame.scene - 1]++;
    previousTimestamp = frame.timestampMs;
    previousScene = frame.scene;
  }
  if (counts.some(count => count === 0)) fail('Every scene needs at least one real captured frame.');
  return manifest;
}

export function buildSceneTimeline(manifest) {
  validateCapture(manifest);
  let outputStartSeconds = 0;
  return manifest.scenes.map((scene, index) => {
    const frames = manifest.frames.filter(frame => frame.scene === scene.id);
    // There is no captured state before the first frame: begin with that actual frame.
    const recordedSeconds = Math.max(0, (scene.endMs - frames[0].timestampMs) / 1000);
    const targetSeconds = SCENE_SECONDS[index];
    const timingScale = recordedSeconds > targetSeconds ? targetSeconds / recordedSeconds : 1;
    const paddingSeconds = Math.max(0, targetSeconds - recordedSeconds);
    const entries = frames.map((frame, frameIndex) => ({
      file: frame.file,
      timestampMs: frame.timestampMs,
      durationSeconds: ((frames[frameIndex + 1]?.timestampMs ?? scene.endMs) - frame.timestampMs) / 1000 * timingScale + (frameIndex === frames.length - 1 ? paddingSeconds : 0),
    }));
    const result = { id: scene.id, outputStartSeconds, targetSeconds, recordedSeconds, timingScale, paddingSeconds, frames: entries };
    outputStartSeconds += targetSeconds;
    return result;
  });
}

export function splitCaptionPhrases(text) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) fail('Narration paragraphs cannot be empty.');
  const count = Math.max(1, Math.round(words.length / 12));
  const phrases = [];
  let offset = 0;
  for (let index = 0; index < count; index++) {
    const size = Math.ceil((words.length - offset) / (count - index));
    const part = words.slice(offset, offset + size);
    let breakIndex = Math.max(1, Math.floor(part.length / 2));
    let best = Infinity;
    for (let candidate = 1; candidate < part.length; candidate++) {
      const difference = Math.abs(part.slice(0, candidate).join(' ').length - part.slice(candidate).join(' ').length);
      if (difference < best) { best = difference; breakIndex = candidate; }
    }
    phrases.push({ text: part.join(' '), lines: part.length > 1 ? [part.slice(0, breakIndex).join(' '), part.slice(breakIndex).join(' ')] : [part[0]], words: part.length });
    offset += size;
  }
  return phrases;
}

const srtTime = seconds => {
  const value = Math.round(seconds * 1000);
  return `${String(Math.floor(value / 3600000)).padStart(2, '0')}:${String(Math.floor(value / 60000) % 60).padStart(2, '0')}:${String(Math.floor(value / 1000) % 60).padStart(2, '0')},${String(value % 1000).padStart(3, '0')}`;
};
const assTime = seconds => {
  const value = Math.round(seconds * 100);
  return `${Math.floor(value / 360000)}:${String(Math.floor(value / 6000) % 60).padStart(2, '0')}:${String(Math.floor(value / 100) % 60).padStart(2, '0')}.${String(value % 100).padStart(2, '0')}`;
};
const assText = text => text.replace(/\\/g, '＼').replace(/{/g, '｛').replace(/}/g, '｝').replace(/[\r\n]/g, ' ');

export function buildCaptions(paragraphs, durations, timeline, { width = 1280, paperHeight = 720, outputHeight = 820 } = {}) {
  if (paragraphs.length !== 8 || durations.length !== 8 || timeline.length !== 8) fail('Eight narration paragraphs, durations and scenes are required.');
  const cues = [];
  paragraphs.forEach((paragraph, index) => {
    const duration = durations[index];
    if (!finite(duration) || duration <= 0 || duration > timeline[index].targetSeconds + 0.00001) fail(`Narration block ${index + 1} exceeds its scene; speech will not be truncated.`);
    const phrases = splitCaptionPhrases(paragraph);
    const totalWords = phrases.reduce((sum, phrase) => sum + phrase.words, 0);
    let elapsedWords = 0;
    for (const phrase of phrases) {
      cues.push({ start: timeline[index].outputStartSeconds + duration * elapsedWords / totalWords, end: timeline[index].outputStartSeconds + duration * (elapsedWords + phrase.words) / totalWords, lines: phrase.lines, scene: index + 1 });
      elapsedWords += phrase.words;
    }
  });
  const srt = cues.map((cue, index) => `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.lines.join('\n')}\n`).join('\n');
  const center = width / 2;
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${outputHeight}\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Caption,Segoe UI,19,&H00FFFFFF,&H00FFFFFF,&H00111827,&H00111827,0,0,0,0,100,100,0,0,1,0,0,8,24,24,0,1\nStyle: Label,Segoe UI,13,&H00C4CCD8,&H00C4CCD8,&H00111827,&H00111827,0,0,0,0,100,100,0,0,1,0,0,8,24,24,0,1\nStyle: Link,Segoe UI,11,&H00C4CCD8,&H00C4CCD8,&H00111827,&H00111827,0,0,0,0,100,100,0,0,1,0,0,8,24,24,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const permanent = `Dialogue: 0,0:00:00.00,0:02:30.00,Label,,0,0,0,,{\\an8\\pos(${center},${paperHeight + 4})}${DISCLOSURE}\nDialogue: 0,0:00:00.00,0:02:30.00,Link,,0,0,0,,{\\an8\\pos(${center},${paperHeight + 82})}${PUBLIC_LINKS}\n`;
  const ass = header + permanent + cues.map(cue => `Dialogue: 1,${assTime(cue.start)},${assTime(cue.end)},Caption,,0,0,0,,{\\an8\\pos(${center},${paperHeight + 27})}${cue.lines.map(assText).join('\\N')}\n`).join('');
  return { cues, srt, ass };
}

function boundedFile(file, root, maxBytes) {
  const actual = fs.realpathSync(file);
  const relative = path.relative(root, actual);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) fail('An input file escapes its declared input directory.');
  const stat = fs.statSync(actual);
  if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) fail('An input file is empty or exceeds its size bound.');
  return actual;
}

export function inspectImageBytes(bytes) {
  const finish = (format, width, height) => {
    if (width < 320 || height < 180 || width > 3840 || height > 2160) fail('Native screenshot dimensions exceed the admitted capture bounds.');
    return { format, width, height };
  };
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') return finish('png', bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) fail('Capture frame content is neither PNG nor JPEG.');
  const sizeMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) fail('JPEG capture marker structure is invalid.');
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) break;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) fail('JPEG capture segment is truncated.');
    if (sizeMarkers.has(marker)) {
      if (length < 8) fail('JPEG capture size segment is truncated.');
      return finish('jpeg', bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
    }
    offset += length;
  }
  fail('JPEG capture has no valid native dimensions.');
}

function probe(executable, file) {
  return JSON.parse(execFileSync(executable, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,pix_fmt,color_range,avg_frame_rate,sample_rate,channels,duration', '-of', 'json', file], { encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: true }));
}

export function buildVideoFilter(outputWidth, outputHeight) {
  // Same-size color-range conversion, not geometric scaling: JPEG/RGB full
  // range becomes conventional limited-range yuv420p for portable H.264 playback.
  return `[0:v]scale=iw:ih:in_range=pc:out_range=tv,format=yuv420p,fps=24,pad=${outputWidth}:${outputHeight}:0:0:color=0x111827,ass=filename=captions.ass[v]`;
}

export function assemble(options) {
  const output = options.output;
  const assemblyRoot = path.join(path.dirname(output), `${path.basename(output, '.mp4')}-assembly`);
  if (!options.overwrite && (fs.existsSync(output) || fs.existsSync(assemblyRoot))) fail('Output or assembly files already exist. Use --overwrite explicitly.');
  if (fs.statSync(options.capture).size > 8 * 1024 * 1024) fail('Capture manifest exceeds 8 MiB.');
  const manifest = validateCapture(JSON.parse(fs.readFileSync(options.capture, 'utf8')));
  const captureRoot = fs.realpathSync(path.dirname(options.capture));
  const frameFormats = manifest.frames.map(frame => inspectImageBytes(fs.readFileSync(boundedFile(frame.file, captureRoot, 32 * 1024 * 1024))));
  const nativeSize = frameFormats[0];
  if (frameFormats.some(frame => frame.width !== nativeSize.width || frame.height !== nativeSize.height || frame.format !== nativeSize.format)) fail('All real capture frames must have consistent native dimensions and image encoding.');
  // H.264 yuv420p requires even dimensions. Pad at most one right/bottom pixel;
  // never resize or crop the native captured website pixels.
  const outputWidth = Math.ceil(nativeSize.width / 2) * 2;
  const outputHeight = Math.ceil((nativeSize.height + FOOTER_HEIGHT) / 2) * 2;
  const audioRoot = fs.realpathSync(options['audio-dir']);
  const audioPaths = SCENE_SECONDS.map((_, index) => boundedFile(path.join(audioRoot, `narration-${String(index + 1).padStart(2, '0')}.wav`), audioRoot, 32 * 1024 * 1024));
  const durations = audioPaths.map(file => {
    const value = probe(options.ffprobe, file);
    if (value.streams?.length !== 1 || value.streams[0].codec_type !== 'audio') fail('Each narration WAV must contain one audio stream only.');
    return Number(value.format.duration);
  });
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const paragraphs = fs.readFileSync(path.join(repositoryRoot, 'docs', 'DEMO-NARRATION.md'), 'utf8').split(/\r?\n/).filter(line => /^>\s+/.test(line)).map(line => line.replace(/^>\s+/, ''));
  const timeline = buildSceneTimeline(manifest);
  const captions = buildCaptions(paragraphs, durations, timeline, { width: outputWidth, paperHeight: nativeSize.height, outputHeight });
  const quoteFile = file => `'${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
  const entries = timeline.flatMap(scene => scene.frames);
  const concat = 'ffconcat version 1.0\n' + entries.map(frame => `file ${quoteFile(frame.file)}\noption framerate 1000\nduration ${frame.durationSeconds.toFixed(9)}\n`).join('') + `file ${quoteFile(entries.at(-1).file)}\noption framerate 1000\n`;
  fs.mkdirSync(assemblyRoot, { recursive: true });
  fs.writeFileSync(path.join(assemblyRoot, 'frames.ffconcat'), concat);
  fs.writeFileSync(path.join(assemblyRoot, 'captions.ass'), captions.ass);
  fs.writeFileSync(path.join(assemblyRoot, 'captions.srt'), captions.srt);
  const metadata = { schemaVersion: 1, sourceCommit: manifest.sourceCommit, releaseFingerprint: manifest.releaseFingerprint, captureManifest: options.capture, output, declaredCaptureSize: { width: manifest.width, height: manifest.height }, nativeFrameSize: nativeSize, outputSize: { width: outputWidth, height: outputHeight }, pixelTreatment: 'No crop or resize; append caption footer and at most one right/bottom pixel for even H264 dimensions', disclosure: DISCLOSURE, subtitleTiming: 'Approximate word-proportional timing within unchanged synthetic narration blocks', narrationSeconds: durations, scenes: timeline.map(({ frames, ...scene }) => ({ ...scene, frameCount: frames.length })), realFrameCount: entries.length };
  fs.writeFileSync(path.join(assemblyRoot, 'assembly.json'), JSON.stringify(metadata, null, 2) + '\n');
  const args = ['-hide_banner', '-nostdin', options.overwrite ? '-y' : '-n', '-f', 'concat', '-safe', '0', '-i', 'frames.ffconcat'];
  for (const file of audioPaths) args.push('-i', file);
  const audioFilters = SCENE_SECONDS.map((seconds, index) => `[${index + 1}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono,apad,atrim=duration=${seconds},asetpts=PTS-STARTPTS[a${index + 1}]`);
  const filters = [buildVideoFilter(outputWidth, outputHeight), ...audioFilters, `${SCENE_SECONDS.map((_, index) => `[a${index + 1}]`).join('')}concat=n=8:v=0:a=1[a]`].join(';');
  args.push('-filter_complex', filters, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-r', '24', '-c:a', 'aac', '-b:a', '160k', '-t', String(TOTAL_SECONDS), '-movflags', '+faststart', '-metadata', 'comment=Real live browser capture, edited timing, synthetic narration. Captions use approximate phrase timing.', output);
  const encoded = spawnSync(options.ffmpeg, args, { cwd: assemblyRoot, stdio: 'inherit', windowsHide: true });
  if (encoded.error || encoded.status !== 0) fail('FFmpeg encoding failed; intermediates remain available for inspection.');
  const finalProbe = probe(options.ffprobe, output);
  const videos = finalProbe.streams?.filter(stream => stream.codec_type === 'video') ?? [];
  const audios = finalProbe.streams?.filter(stream => stream.codec_type === 'audio') ?? [];
  const seconds = Number(finalProbe.format?.duration);
  if (videos.length !== 1 || audios.length !== 1 || videos[0].codec_name !== 'h264' || videos[0].pix_fmt !== 'yuv420p' || videos[0].avg_frame_rate !== '24/1' || videos[0].width !== outputWidth || videos[0].height !== outputHeight || !finite(seconds) || Math.abs(seconds - TOTAL_SECONDS) > 0.05 || seconds >= 180) fail('Encoded video failed the duration or media-stream verification.');
  fs.writeFileSync(path.join(assemblyRoot, 'verified-media.json'), JSON.stringify(finalProbe, null, 2) + '\n');
  const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const publicProof = { schemaVersion: 1, sourceCommit: manifest.sourceCommit, releaseFingerprint: manifest.releaseFingerprint, captureManifestSha256: sha256(options.capture), videoSha256: sha256(output), captionsSha256: sha256(path.join(assemblyRoot, 'captions.srt')), videoBytes: fs.statSync(output).size, durationSeconds: seconds, nativeCapture: { ...nativeSize, frameCount: entries.length, elapsedSeconds: (manifest.scenes.at(-1).endMs - manifest.scenes[0].startMs) / 1000 }, encodedVideo: videos[0], encodedAudio: audios[0], disclosure: DISCLOSURE, subtitleTiming: metadata.subtitleTiming, pixelTreatment: metadata.pixelTreatment, originalScreenshotsPreserved: true };
  const publicTimeline = { schemaVersion: 1, sourceCommit: manifest.sourceCommit, releaseFingerprint: manifest.releaseFingerprint, targetDurationSeconds: TOTAL_SECONDS, disclosure: DISCLOSURE, scenes: metadata.scenes.map((scene, index) => ({ ...scene, narrationSeconds: durations[index] })) };
  fs.writeFileSync(path.join(assemblyRoot, 'recording-verification.json'), JSON.stringify(publicProof, null, 2) + '\n');
  fs.writeFileSync(path.join(assemblyRoot, 'timeline.json'), JSON.stringify(publicTimeline, null, 2) + '\n');
  return { output, seconds, realFrameCount: entries.length, captions: path.join(assemblyRoot, 'captions.srt'), assembly: path.join(assemblyRoot, 'assembly.json'), verification: path.join(assemblyRoot, 'recording-verification.json'), timeline: path.join(assemblyRoot, 'timeline.json') };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(assemble(parseArguments(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(`Demo assembly failed: ${error instanceof Error ? error.message : 'unknown error'}`); process.exitCode = 1; }
}
