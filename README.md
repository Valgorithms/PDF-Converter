# PDF-Converter

Converts images into a PDF with one page per image, in the order you choose, each page exactly the size of its image: one pixel becomes one point.

It started as a port of a short Python script that did this for one image with Pillow and ReportLab, and comes in two forms that build the same PDF:

- **In the browser**, as a page published with GitHub Pages. The images are converted on your own computer and never uploaded.
- **In PHP**, as a command-line script and a library. The only requirements are PHP's `gd` and `zlib` extensions, which PHP ships with; there are no Composer dependencies.

## In the browser

Open the site, then choose or drop your images; you can add more at any time. Each becomes a page, listed in order.

- **Reorder** pages by dragging them, or with each page's ↑ and ↓ buttons, which also work from the keyboard and on touch screens.
- **Remove** a page with ×, or every page with **Remove all**.
- **Make PDF** builds the file, and **Download PDF** saves it, named after the first page's image.

Images are decoded one at a time when the PDF is made, so a stack of large photos doesn't all sit in memory at once. The page is plain HTML and JavaScript modules in [`web/`](web), with no build step and nothing loaded from other sites.

The [Publish site](.github/workflows/pages.yml) workflow publishes the site to the `gh-pages` branch whenever `web/` or `src/` changes on `main`, and on each release. The converter is the site's root page; the PHP class reference, built with phpDocumentor, is under `/reference/`. To serve it, set **Settings → Pages → Source** to *Deploy from a branch*, with `gh-pages` and `/ (root)`.

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

This writes `scan.pdf` beside the image and prints its path. Give several images to make a page of each, in the order given, and an argument ending in `.pdf` to choose where the PDF goes:

```bash
php bin/image-to-pdf page-1.jpg page-2.jpg page-3.png out/document.pdf
```

Without a `.pdf` argument, the PDF is written beside the first image. The script exits with `1` and a message on standard error when an image cannot be read or is not an image.

## Library

```php
use PdfConverter\ImageToPdf;

// One image, one page
ImageToPdf::convert('scan.png', 'scan.pdf');   // Writes the PDF and returns its path
$pdf = ImageToPdf::fromFile('scan.png');       // The PDF's bytes
$pdf = ImageToPdf::fromString($imageBytes);    // The same, from image bytes already in memory

// Several images, a page for each, in order
ImageToPdf::convertAll(['1.jpg', '2.jpg', '3.png'], 'document.pdf');
$pdf = ImageToPdf::fromFiles(['1.jpg', '2.jpg', '3.png']);
$pdf = ImageToPdf::fromStrings([$first, $second], ['first.jpg', 'second.jpg']); // Names are for error messages
```

The methods that read or write files throw a `RuntimeException` when a file cannot be read or written. All of them throw an `InvalidArgumentException` when an image's bytes are not an image, naming the image, or when there are no images.

## What it does with each image

- **Formats:** anything GD can read, which is PNG, JPEG, GIF, WebP, BMP and AVIF.
- **Colour:** pixels are stored as 8-bit RGB, compressed with Flate.
- **Transparency:** kept as a soft mask, so transparent areas show the white page. GD stores alpha in 7 bits, so alpha is kept to within one step of 255. The original script used ReportLab without a mask, which drops transparency instead.
- **Pages:** each page is the size of its own image, so a PDF can mix portrait and landscape pages.
- **Memory and time:** a US Letter page scanned at 300 dpi (2550 × 3300 pixels) takes about 4 seconds and peaks near 70 MB, most of it GD's copy of the image. Images are decoded one at a time and only their compressed pixels are kept, so memory is about the largest image plus the finished PDF, not every image at once. The command-line script lifts PHP's memory limit so that larger photos convert; when you call the library yourself, allow about 8 bytes per pixel of the largest image.

## Tests

```bash
composer install
composer test
```

The browser version's tests use Node's built-in test runner and need Node 22 or later:

```bash
composer test-web
```

## Coding standards and documentation

The PHP code is formatted with php-cs-fixer, using [`.php-cs-fixer.dist.php`](.php-cs-fixer.dist.php); the Coding Standards workflow fails a push that isn't formatted.

```bash
composer cs
```

The class reference is built with [phpDocumentor](https://phpdoc.org) from [`phpdoc.dist.xml`](phpdoc.dist.xml) into `build/reference/`. To build it locally, install phpDocumentor (for example with `phive install phpDocumentor`) and run it from the repository root:

```bash
tools/phpDocumentor --config phpdoc.dist.xml
```
