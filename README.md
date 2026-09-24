# PDF-Converter

Converts an image into a single-page PDF whose page is exactly the size of the image: one pixel becomes one point.

It is a port of a short Python script that did the same with Pillow and ReportLab, in two forms that build the same PDF:

- **In the browser**, as a page published with GitHub Pages. The image is converted on your own computer and never uploaded.
- **In PHP**, as a command-line script and a library. The only requirements are PHP's `gd` and `zlib` extensions, which PHP ships with; there are no Composer dependencies.

## In the browser

Open the site, choose or drop an image, and download the PDF. The page is plain HTML and a JavaScript module in [`web/`](web), with no build step and nothing loaded from other sites.

The [Publish site](.github/workflows/pages.yml) workflow copies `web/` to the `gh-pages` branch whenever it changes on `main`. To serve it, set **Settings → Pages → Source** to *Deploy from a branch*, with `gh-pages` and `/ (root)`.

To try it locally, serve the folder, since browsers only load modules over HTTP:

```bash
php -S 127.0.0.1:8080 -t web
```

The browser reads the same formats as the PHP version, as far as the browser supports them. Unlike GD, it applies a photo's EXIF orientation, so a phone photo comes out the right way up.

## PHP requirements

- PHP 8.1 or later.
- The `gd` and `zlib` extensions. On Windows, `gd` may need `extension=gd` enabled in `php.ini`; `php -m` lists what is loaded.

## Command line

```bash
php bin/image-to-pdf scan.png
```

This writes `scan.pdf` beside the image and prints its path. Give a second argument to choose where the PDF goes:

```bash
php bin/image-to-pdf scan.png out/document.pdf
```

The script exits with `1` and a message on standard error when the image cannot be read or is not an image.

## Library

```php
use PdfConverter\ImageToPdf;

ImageToPdf::convert('scan.png', 'scan.pdf'); // Writes the PDF and returns its path
$pdf = ImageToPdf::fromFile('scan.png');     // The PDF's bytes
$pdf = ImageToPdf::fromString($imageBytes);  // The same, from image bytes already in memory
```

`fromFile()` and `convert()` throw a `RuntimeException` when a file cannot be read or written. All three throw an `InvalidArgumentException` when the bytes are not an image.

## What it does with the image

- **Formats:** anything GD can read, which is PNG, JPEG, GIF, WebP, BMP and AVIF.
- **Colour:** pixels are stored as 8-bit RGB, compressed with Flate.
- **Transparency:** kept as a soft mask, so transparent areas show the white page. GD stores alpha in 7 bits, so alpha is kept to within one step of 255. The original script used ReportLab without a mask, which drops transparency instead.
- **Memory and time:** a US Letter page scanned at 300 dpi (2550 × 3300 pixels) takes about 4 seconds and peaks near 70 MB, most of it GD's copy of the image. The command-line script lifts PHP's memory limit so that larger photos convert; when you call the library yourself, allow about 8 bytes per pixel.

## Tests

```bash
composer install
composer test
```

The browser version's tests use Node's built-in test runner and need Node 22 or later:

```bash
composer test-web
```
