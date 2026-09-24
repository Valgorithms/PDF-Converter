// Converts an image into a single-page PDF whose page is exactly the size of the image,
// entirely in the browser: one pixel becomes one point, and transparency becomes a soft mask.
// The same PDF layout as src/ImageToPdf.php, so the PHP and browser versions agree.

const encoder = new TextEncoder();

/**
 * Decodes an image file with the browser and converts it.
 *
 * @param {Blob} file Any image the browser can decode (PNG, JPEG, GIF, WebP, AVIF, BMP).
 * @returns {Promise<{pdf: Uint8Array, width: number, height: number}>}
 */
export async function imageToPdf(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  } catch {
    throw new Error(`${file.name ?? 'The file'} is not an image this browser can read.`);
  }

  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();

  const { data } = context.getImageData(0, 0, width, height);

  return { pdf: await pdfFromPixels(width, height, data), width, height };
}

/**
 * Builds the PDF from RGBA pixels, top row first.
 *
 * @param {number} width The image's width in pixels, and the page's in points.
 * @param {number} height The image's height in pixels, and the page's in points.
 * @param {Uint8Array|Uint8ClampedArray} rgba Four bytes per pixel.
 * @returns {Promise<Uint8Array>}
 */
export async function pdfFromPixels(width, height, rgba) {
  const pixels = width * height;
  const rgb = new Uint8Array(pixels * 3);
  const alpha = new Uint8Array(pixels);
  let translucent = false;

  for (let i = 0; i < pixels; i++) {
    rgb[i * 3] = rgba[i * 4];
    rgb[i * 3 + 1] = rgba[i * 4 + 1];
    rgb[i * 3 + 2] = rgba[i * 4 + 2];
    alpha[i] = rgba[i * 4 + 3];
    translucent ||= alpha[i] !== 255;
  }

  const image = (colorSpace, samples, extra) => stream(
    `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /${colorSpace} /BitsPerComponent 8 /Filter /FlateDecode${extra}`,
    samples,
  );

  const objects = [
    text('<< /Type /Catalog /Pages 2 0 R >>'),
    text('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    text(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`),
    image('DeviceRGB', await deflate(rgb), translucent ? ' /SMask 6 0 R' : ''),
    // Scale the unit-square image to the page.
    stream('<<', text(`q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`)),
  ];

  if (translucent) {
    objects.push(image('DeviceGray', await deflate(alpha), ''));
  }

  // The comment of high bytes marks the file as binary for tools that guess.
  const parts = [text('%PDF-1.4\n%'), new Uint8Array([0xE2, 0xE3, 0xCF, 0xD3]), text('\n')];
  let length = parts.reduce((sum, part) => sum + part.length, 0);
  const offsets = [];

  objects.forEach((object, index) => {
    offsets.push(length);
    for (const part of [text(`${index + 1} 0 obj\n`), object, text('\nendobj\n')]) {
      parts.push(part);
      length += part.length;
    }
  });

  const size = objects.length + 1;
  const xref = [`xref\n0 ${size}\n0000000000 65535 f \n`]
    .concat(offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`))
    .join('');
  parts.push(text(`${xref}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));

  return concat(parts);
}

/** A stream object: its dictionary, which this closes after adding the length, and its data. */
function stream(dictionary, data) {
  return concat([text(`${dictionary} /Length ${data.length} >>\nstream\n`), data, text('\nendstream')]);
}

/** Compresses with zlib, which is what `/FlateDecode` reads. */
async function deflate(bytes) {
  const compressed = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));

  return new Uint8Array(await new Response(compressed).arrayBuffer());
}

function text(string) {
  return encoder.encode(string);
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }

  return out;
}
