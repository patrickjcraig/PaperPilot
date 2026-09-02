import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { SCENE_SECONDS, TOTAL_SECONDS, parseArguments, validateCapture, buildSceneTimeline, splitCaptionPhrases, buildCaptions, inspectImageBytes, buildVideoFilter } from './assemble-demo-video.mjs';

function capture(seconds = 30) {
  return { schemaVersion: 1, width: 1280, height: 720, sourceCommit: 'a'.repeat(40), releaseFingerprint: 'b'.repeat(64), scenes: Array.from({ length: 8 }, (_, index) => ({ id: index + 1, startMs: index * seconds * 1000, endMs: (index + 1) * seconds * 1000 })), frames: Array.from({ length: 16 }, (_, index) => ({ file: path.resolve('tmp', 'capture', `frame-${index}.png`), scene: Math.floor(index / 2) + 1, timestampMs: index * seconds * 500 })) };
}

test('all eight target scenes total exactly 150 seconds', () => {
  assert.equal(SCENE_SECONDS.reduce((sum, value) => sum + value, 0), TOTAL_SECONDS);
  const manifest = capture();
  const original = JSON.stringify(manifest);
  const timeline = buildSceneTimeline(manifest);
  assert.equal(JSON.stringify(manifest), original);
  assert.deepEqual(timeline.flatMap(scene => scene.frames.map(frame => frame.file)), manifest.frames.map(frame => frame.file));
  for (const scene of timeline) assert.ok(Math.abs(scene.frames.reduce((sum, frame) => sum + frame.durationSeconds, 0) - scene.targetSeconds) < 1e-9);
  assert.equal(timeline.at(-1).outputStartSeconds, 129.5);
});

test('long scenes compress interframe timing proportionally; short scenes pad only the last real frame', () => {
  const long = buildSceneTimeline(capture(30))[0];
  assert.equal(long.timingScale, 0.5);
  assert.deepEqual(long.frames.map(frame => frame.durationSeconds), [7.5, 7.5]);
  const short = buildSceneTimeline(capture(10))[0];
  assert.equal(short.timingScale, 1);
  assert.deepEqual(short.frames.map(frame => frame.durationSeconds), [5, 10]);
  assert.equal(short.paddingSeconds, 5);
});

test('reject missing scenes, reordered frames, duplicate files and false dimensions', () => {
  for (const mutate of [m => m.scenes.pop(), m => m.frames.reverse(), m => { m.frames[1].file = m.frames[0].file; }, m => { m.width = 99999; }, m => { m.frames[0].timestampMs = -1; }, m => { m.frames = m.frames.filter(frame => frame.scene !== 4); }, m => { m.sourceCommit = 'latest'; }]) {
    const manifest = capture(); mutate(manifest); assert.throws(() => validateCapture(manifest));
  }
});

test('content inspection accepts native JPEG dimensions regardless of misleading PNG filename', () => {
  // Header-only parser fixture; not a generated demo image.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 8, 8, 2, 200, 4, 241, 0]);
  assert.deepEqual(inspectImageBytes(jpeg), { format: 'jpeg', width: 1265, height: 712 });
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.write('IHDR', 12); png.writeUInt32BE(1280, 16); png.writeUInt32BE(720, 20);
  assert.deepEqual(inspectImageBytes(png), { format: 'png', width: 1280, height: 720 });
  assert.throws(() => inspectImageBytes(Buffer.from('not an image')));
  assert.throws(() => inspectImageBytes(jpeg.subarray(0, 15)), /truncated/);
});

test('caption footer follows native screenshot height without scaling its pixels', () => {
  const result = buildCaptions(Array(8).fill('The paper stays untouched.'), Array(8).fill(4), buildSceneTimeline(capture()), { width: 1266, paperHeight: 712, outputHeight: 812 });
  assert.match(result.ass, /PlayResX: 1266\nPlayResY: 812/);
  assert.match(result.ass, /pos\(633,716\)/);
  assert.match(result.ass, /pos\(633,739\)/);
});

test('JPEG color-range conversion retains native geometry and pads instead of cropping', () => {
  const filter = buildVideoFilter(1266, 812);
  assert.match(filter, /scale=iw:ih:in_range=pc:out_range=tv,format=yuv420p/);
  assert.match(filter, /pad=1266:812:0:0/);
  assert.doesNotMatch(filter, /crop=/);
});

test('caption phrases preserve all words and use at most two lines', () => {
  const text = 'Paper evidence stays separate from mentor interpretation and background while exact source references let readers return to the original material with confidence about its location.';
  const phrases = splitCaptionPhrases(text);
  assert.equal(phrases.map(phrase => phrase.text).join(' '), text);
  assert.ok(phrases.every(phrase => phrase.lines.length <= 2 && phrase.words <= 14));
});

test('caption authority label is permanent, text is escaped and block eight is not truncated', () => {
  const timeline = buildSceneTimeline(capture());
  const paragraphs = Array(8).fill('A literal {caption} with \\N words must remain plain text and preserve its meaning.');
  const durations = [10, 14, 13, 16, 16, 13, 12, 20.2895];
  const captions = buildCaptions(paragraphs, durations, timeline);
  assert.match(captions.ass, /Edited live capture · timing compressed · synthetic narration/);
  assert.match(captions.ass, /｛caption｝/);
  assert.match(captions.ass, /＼N/);
  assert.ok(captions.cues.at(-1).end < 150);
  assert.ok(captions.cues.at(-1).end > 149.7);
  durations[7] = 20.6;
  assert.throws(() => buildCaptions(paragraphs, durations, timeline), /will not be truncated/);
});

test('CLI requires explicit inputs and explicit overwrite flag', () => {
  const args = ['--capture', 'capture.json', '--audio-dir', 'audio', '--output', 'demo.mp4', '--ffmpeg', 'ffmpeg.exe', '--ffprobe', 'ffprobe.exe'];
  assert.equal(parseArguments(args).overwrite, undefined);
  assert.equal(parseArguments([...args, '--overwrite']).overwrite, true);
  assert.throws(() => parseArguments([...args, '--output', 'other.mp4']));
  assert.throws(() => parseArguments(args.slice(0, -2)));
  assert.throws(() => parseArguments(['--unknown', 'x']));
});
