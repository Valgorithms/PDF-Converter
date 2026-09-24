// Tests the browser converter's PDF builder with Node's own test runner: node --test tests/web/*.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { assemble, encodePage, pdfFromPixels } from '../../web/image-to-pdf.js';

const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');

/** An object's dictionary, and its stream's data when it has one, sliced by its /Length. */
function object(pdf, number) {
  const bytes = Buffer.from(pdf);
  const text = latin1(pdf);
  const start = text.indexOf(`\n${number} 0 obj\n`) + `\n${number} 0 obj\n`.length;
  assert.ok(start > `\n${number} 0 obj\n`.length - 1, `object ${number} exists`);

  const head = /^(<<(?:(?!\nendobj)[\s\S])*?>>)\nstream\n/.exec(text.slice(start));
  if (!head) {
    return [text.slice(start, text.indexOf('\nendobj', start)), null];
  }

  const length = Number(/\/Length (\d+)/.exec(head[1])[1]);
  const from = start + head[0].length;

  return [head[1], bytes.subarray(from, from + length)];
}

/** RGBA pixels from [r, g, b, a] tuples. */
const pixels = (...rgba) => new Uint8Array(rgba.flat());

test('the image fills a page the size of the image', async () => {
  const pdf = await pdfFromPixels(3, 2, pixels(
    [255, 0, 0, 255], [0, 0, 0, 255], [0, 0, 0, 255],
    [0, 0, 0, 255], [0, 0, 0, 255], [0, 0, 255, 255],
  ));

  assert.ok(latin1(pdf).startsWith('%PDF-1.4'));
  assert.match(object(pdf, 3)[0], /\/MediaBox \[0 0 3 2\]/);
  assert.equal(latin1(object(pdf, 5)[1]), 'q 3 0 0 2 0 0 cm /Im0 Do Q');

  const [image, samples] = object(pdf, 4);
  assert.match(image, /\/Width 3 \/Height 2 \/ColorSpace \/DeviceRGB \/BitsPerComponent 8/);
  assert.doesNotMatch(image, /\/SMask/, 'an opaque image needs no mask');
  assert.deepEqual([...inflateSync(samples)], [255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255]);
});

test('transparency becomes a soft mask', async () => {
  const pdf = await pdfFromPixels(3, 1, pixels([10, 20, 30, 0], [10, 20, 30, 128], [10, 20, 30, 255]));

  assert.match(object(pdf, 4)[0], /\/SMask 6 0 R/);

  const [mask, alpha] = object(pdf, 6);
  assert.match(mask, /\/ColorSpace \/DeviceGray/);
  assert.deepEqual([...inflateSync(alpha)], [0, 128, 255]);
});

test('every cross-reference points at its object', async () => {
  const pdf = await pdfFromPixels(5, 4, new Uint8Array(5 * 4 * 4).fill(255));
  const text = latin1(pdf);
  const start = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)[1]);
  const table = text.slice(start);
  const entries = [...table.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));

  assert.ok(table.startsWith('xref\n0 6\n0000000000 65535 f \n'));
  assert.equal(entries.length, 5);
  entries.forEach((offset, index) => assert.ok(text.startsWith(`${index + 1} 0 obj`, offset)));
});

test('each image becomes a page in the order given', async () => {
  const opaque = (width, height) => new Uint8Array(width * height * 4).fill(255);
  const withHole = opaque(5, 4);
  withHole[3] = 0;

  const pdf = assemble([
    await encodePage(3, 2, opaque(3, 2)),
    await encodePage(5, 4, withHole),
    await encodePage(2, 7, opaque(2, 7)),
  ]);

  // Page 1 takes objects 3–5, page 2 (with a mask) 6–9, page 3 10–12.
  assert.match(object(pdf, 2)[0], /\/Kids \[3 0 R 6 0 R 10 0 R\] \/Count 3/);
  assert.deepEqual([3, 6, 10].map((page) => /\/MediaBox \[0 0 (\d+) (\d+)\]/.exec(object(pdf, page)[0]).slice(1).join(' ')), ['3 2', '5 4', '2 7']);
  assert.match(object(pdf, 6)[0], /\/Im0 7 0 R/, 'each page names its own image');
  assert.match(object(pdf, 7)[0], /\/SMask 9 0 R/, 'only the image with transparency has a mask');
  assert.doesNotMatch(object(pdf, 11)[0], /\/SMask/);
  assert.equal(latin1(object(pdf, 12)[1]), 'q 2 0 0 7 0 0 cm /Im0 Do Q');

  const text = latin1(pdf);
  const start = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)[1]);
  const entries = [...text.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  assert.equal(entries.length, 12);
  entries.forEach((offset, index) => assert.ok(text.startsWith(`${index + 1} 0 obj`, offset)));
});

test('no images is refused', () => {
  assert.throws(() => assemble([]), /There are no images to convert/);
});
