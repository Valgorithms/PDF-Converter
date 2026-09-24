// Tests the browser converter's PDF builder with Node's own test runner: node --test tests/web
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { pdfFromPixels } from '../../web/image-to-pdf.js';

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
