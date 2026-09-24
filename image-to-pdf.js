// Converts images into a PDF with a page for each, every page exactly the size of its image, entirely
// in the browser: one pixel becomes one point, and transparency becomes a soft mask.
// The same PDF layout as src/ImageToPdf.php, so the PHP and browser versions agree.

const encoder = new TextEncoder();

/**
 * Decodes image files with the browser and converts them, one page per image in the order given.
 *
 * Images are decoded one at a time and only their compressed pixels are kept, so many large photos can
 * go into one PDF.
 *
 * @param {Blob[]} files Images the browser can decode (PNG, JPEG, GIF, WebP, AVIF, BMP).
 * @param {(done: number, total: number) => void} onPage Told after each page is made.
 * @returns {Promise<Uint8Array>}
 */
export async function imagesToPdf(files, onPage = () => {}) {
  const pages = [];
  for (const file of files) {
    const { width, height, rgba } = await decode(file);
    pages.push(await encodePage(width, height, rgba));
    onPage(pages.length, files.length);
  }
  return assemble(pages);
}

/**
 * Decodes one image file and converts it into a one-page PDF.
 *
 * @param {Blob} file
 * @returns {Promise<{pdf: Uint8Array, width: number, height: number}>}
 */
export async function imageToPdf(file) {
  const { width, height, rgba } = await decode(file);
  return { pdf: assemble([await encodePage(width, height, rgba)]), width, height };
}

/**
 * Builds a one-page PDF from RGBA pixels, top row first.
 *
 * @param {number} width The image's width in pixels, and the page's in points.
 * @param {number} height The image's height in pixels, and the page's in points.
 * @param {Uint8Array|Uint8ClampedArray} rgba Four bytes per pixel.
 * @returns {Promise<Uint8Array>}
 */
export async function pdfFromPixels(width, height, rgba) {
  return assemble([await encodePage(width, height, rgba)]);
}

/**
 * Decodes an image file into RGBA pixels, as they are stored, without colour management.
 *
 * @param {Blob} file
 * @returns {Promise<{width: number, height: number, rgba: Uint8ClampedArray}>}
 */
export async function decode(file) {
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

  return { width, height, rgba: context.getImageData(0, 0, width, height).data };
}

/**
 * One page's image: its size, and its RGB and alpha samples compressed with zlib. Alpha is null when every
 * pixel is opaque.
 *
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array|Uint8ClampedArray} rgba Four bytes per pixel, top row first.
 * @returns {Promise<{width: number, height: number, rgb: Uint8Array, alpha: Uint8Array|null}>}
 */
export async function encodePage(width, height, rgba) {
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

  return { width, height, rgb: await deflate(rgb), alpha: translucent ? await deflate(alpha) : null };
}

/**
 * Builds a PDF with a page for each encoded image, each drawn across its whole page.
 *
 * Each page takes the next object numbers in turn: the page, its image, its content and, when the image
 * has transparency, its mask. One image therefore gives objects 3 to 5 or 6.
 *
 * @param {{width: number, height: number, rgb: Uint8Array, alpha: Uint8Array|null}[]} pages From {@link encodePage}.
 * @returns {Uint8Array}
 */
export function assemble(pages) {
  if (!pages.length) {
    throw new Error('There are no images to convert.');
  }

  const objects = new Map([[1, text('<< /Type /Catalog /Pages 2 0 R >>')]]);
  const kids = [];
  let next = 3;

  for (const { width, height, rgb, alpha } of pages) {
    const page = next++;
    const image = next++;
    const content = next++;
    const mask = alpha === null ? null : next++;
    const picture = (colorSpace, samples, extra) => stream(
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /${colorSpace} /BitsPerComponent 8 /Filter /FlateDecode${extra}`,
      samples,
    );
    kids.push(`${page} 0 R`);

    objects.set(page, text(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 ${image} 0 R >> >> /Contents ${content} 0 R >>`));
    objects.set(image, picture('DeviceRGB', rgb, mask === null ? '' : ` /SMask ${mask} 0 R`));
    // Scale the unit-square image to the page.
    objects.set(content, stream('<<', text(`q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`)));
    if (mask !== null) {
      objects.set(mask, picture('DeviceGray', alpha, ''));
    }
  }

  objects.set(2, text(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`));

  // The comment of high bytes marks the file as binary for tools that guess.
  const parts = [text('%PDF-1.4\n%'), new Uint8Array([0xE2, 0xE3, 0xCF, 0xD3]), text('\n')];
  let length = parts.reduce((sum, part) => sum + part.length, 0);
  const offsets = [];

  for (const number of [...objects.keys()].sort((a, b) => a - b)) {
    offsets.push(length);
    for (const part of [text(`${number} 0 obj\n`), objects.get(number), text('\nendobj\n')]) {
      parts.push(part);
      length += part.length;
    }
  }

  const size = objects.size + 1;
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
