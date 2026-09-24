<?php

declare(strict_types=1);

namespace PdfConverter;

/**
 * Converts images into a PDF with a page for each, every page exactly the size of its image.
 *
 * One pixel becomes one point, as in the ReportLab script this was ported from. Any format GD can read
 * works (PNG, JPEG, GIF, WebP, BMP and AVIF). Transparency is kept as a soft mask, so transparent areas
 * show the white page; GD stores alpha in 7 bits, so it is kept to within one step of 255.
 *
 * Images are decoded one at a time, and only their compressed pixels are kept, so many large images can
 * go into one PDF.
 *
 * Needs only the gd and zlib extensions, which PHP ships with.
 */
final class ImageToPdf
{
    /**
     * Converts an image file and writes a one-page PDF.
     *
     * @param string $imagePath The image to convert.
     * @param string $pdfPath   Where to write the PDF; an existing file is replaced.
     *
     * @throws \RuntimeException         The image could not be read, or the PDF could not be written.
     * @throws \InvalidArgumentException The file is not an image GD can read.
     *
     * @return string The PDF's path.
     */
    public static function convert(string $imagePath, string $pdfPath): string
    {
        return self::convertAll([$imagePath], $pdfPath);
    }

    /**
     * Converts image files and writes a PDF with a page for each, in the order given.
     *
     * @param list<string> $imagePaths The images to convert, one per page.
     * @param string       $pdfPath    Where to write the PDF; an existing file is replaced.
     *
     * @throws \RuntimeException         An image could not be read, or the PDF could not be written.
     * @throws \InvalidArgumentException A file is not an image GD can read, or there are no images.
     *
     * @return string The PDF's path.
     */
    public static function convertAll(array $imagePaths, string $pdfPath): string
    {
        $pdf = self::fromFiles($imagePaths);

        if (false === @file_put_contents($pdfPath, $pdf)) {
            throw new \RuntimeException("Could not write {$pdfPath}.");
        }

        return $pdfPath;
    }

    /**
     * Converts an image file into the bytes of a one-page PDF.
     *
     * @param string $imagePath The image to convert.
     *
     * @throws \RuntimeException         The image could not be read.
     * @throws \InvalidArgumentException The file is not an image GD can read.
     */
    public static function fromFile(string $imagePath): string
    {
        return self::fromFiles([$imagePath]);
    }

    /**
     * Converts image files into the bytes of a PDF with a page for each, in the order given.
     *
     * Each file is read only when its page is made.
     *
     * @param list<string> $imagePaths The images to convert, one per page.
     *
     * @throws \RuntimeException         An image could not be read.
     * @throws \InvalidArgumentException A file is not an image GD can read, or there are no images.
     */
    public static function fromFiles(array $imagePaths): string
    {
        return self::fromImages((static function () use ($imagePaths): \Generator {
            foreach ($imagePaths as $imagePath) {
                $bytes = is_file($imagePath) ? @file_get_contents($imagePath) : false;

                if (false === $bytes) {
                    throw new \RuntimeException("Could not read {$imagePath}.");
                }

                yield [$bytes, $imagePath];
            }
        })());
    }

    /**
     * Converts image bytes into the bytes of a one-page PDF.
     *
     * @param string $bytes The image file's contents.
     * @param string $name  What to call the image in an error message.
     *
     * @throws \InvalidArgumentException The bytes are not an image GD can read.
     */
    public static function fromString(string $bytes, string $name = 'The image'): string
    {
        return self::fromStrings([$bytes], [$name]);
    }

    /**
     * Converts images' bytes into the bytes of a PDF with a page for each, in the order given.
     *
     * @param list<string> $images Each image file's contents, one per page.
     * @param list<string> $names  What to call each image in an error message; by default "Image 1", "Image 2" and so on.
     *
     * @throws \InvalidArgumentException An image is not one GD can read, or there are no images.
     */
    public static function fromStrings(array $images, array $names = []): string
    {
        return self::fromImages((static function () use ($images, $names): \Generator {
            foreach (array_values($images) as $index => $bytes) {
                yield [$bytes, $names[$index] ?? 'Image '.($index + 1)];
            }
        })());
    }

    /**
     * Decodes and compresses each image in turn, then builds the PDF.
     *
     * @param iterable<array{0: string, 1: string}> $images Each image's bytes and what to call it in an error message.
     *
     * @throws \InvalidArgumentException An image is not one GD can read, or there are no images.
     */
    private static function fromImages(iterable $images): string
    {
        $pages = [];

        foreach ($images as [$bytes, $name]) {
            $image = '' === $bytes ? false : @imagecreatefromstring($bytes);

            if (false === $image) {
                throw new \InvalidArgumentException("{$name} is not an image GD can read (PNG, JPEG, GIF, WebP, BMP or AVIF).");
            }

            [$rgb, $alpha] = self::samples($image);
            $pages[] = [imagesx($image), imagesy($image), $rgb, $alpha];
        }

        if ([] === $pages) {
            throw new \InvalidArgumentException('There are no images to convert.');
        }

        return self::document($pages);
    }

    /**
     * Reads an image's pixels, top row first, as 8-bit RGB samples and 8-bit alpha samples, compressed with zlib.
     *
     * Each row is compressed as it is read, so the uncompressed pixels are never held in memory all at once.
     *
     * @return array{0: string, 1: ?string} The compressed RGB samples, and the compressed alpha samples, or null when every pixel is opaque.
     */
    private static function samples(\GdImage $image): array
    {
        if (! imageistruecolor($image)) {
            imagepalettetotruecolor($image);
        }

        $width = imagesx($image);
        $height = imagesy($image);
        $rgbStream = deflate_init(ZLIB_ENCODING_DEFLATE);
        $alphaStream = deflate_init(ZLIB_ENCODING_DEFLATE);
        $rgb = '';
        $alpha = '';
        $translucent = false;

        for ($y = 0; $y < $height; ++$y) {
            $rowRgb = [];
            $rowAlpha = [];

            for ($x = 0; $x < $width; ++$x) {
                $color = imagecolorat($image, $x, $y);
                $rowRgb[] = ($color >> 16) & 0xFF;
                $rowRgb[] = ($color >> 8) & 0xFF;
                $rowRgb[] = $color & 0xFF;

                // GD's alpha runs from 0 (opaque) to 127 (transparent); a PDF soft mask runs from 0 (transparent) to 255 (opaque).
                $transparency = ($color >> 24) & 0x7F;
                $rowAlpha[] = 255 - intdiv($transparency * 255 + 63, 127);
                $translucent = $translucent || 0 !== $transparency;
            }

            $rgb .= deflate_add($rgbStream, pack('C*', ...$rowRgb), ZLIB_NO_FLUSH);
            $alpha .= deflate_add($alphaStream, pack('C*', ...$rowAlpha), ZLIB_NO_FLUSH);
        }

        $rgb .= deflate_add($rgbStream, '', ZLIB_FINISH);

        return [$rgb, $translucent ? $alpha.deflate_add($alphaStream, '', ZLIB_FINISH) : null];
    }

    /**
     * Builds a PDF with a page for each image, each image drawn across its whole page.
     *
     * Each page takes the next object numbers in turn: the page, its image, its content and, when the image
     * has transparency, its mask. One image therefore gives objects 3 to 5 or 6, as it always has.
     *
     * @param list<array{0: int, 1: int, 2: string, 3: ?string}> $pages Each image's width and height in pixels, which are its page's in
     *                                                                   points, and its RGB and alpha samples compressed with zlib, top
     *                                                                   row first; alpha is null for an opaque image.
     */
    private static function document(array $pages): string
    {
        $objects = [1 => '<< /Type /Catalog /Pages 2 0 R >>'];
        $kids = [];
        $next = 3;

        foreach ($pages as [$width, $height, $rgb, $alpha]) {
            $page = $next++;
            $image = $next++;
            $content = $next++;
            $mask = null === $alpha ? null : $next++;
            $kids[] = "{$page} 0 R";

            $objects[$page] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {$width} {$height}] /Resources << /XObject << /Im0 {$image} 0 R >> >> /Contents {$content} 0 R >>";
            $objects[$image] = self::image($width, $height, 'DeviceRGB', $rgb, null === $mask ? '' : " /SMask {$mask} 0 R");
            // Scale the unit-square image to the page.
            $objects[$content] = self::stream('<<', "q {$width} 0 0 {$height} 0 0 cm /Im0 Do Q");

            if (null !== $mask) {
                $objects[$mask] = self::image($width, $height, 'DeviceGray', $alpha, '');
            }
        }

        $objects[2] = '<< /Type /Pages /Kids ['.implode(' ', $kids).'] /Count '.count($kids).' >>';
        ksort($objects);

        // The comment of high bytes marks the file as binary for tools that guess.
        $pdf = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
        $offsets = [];

        foreach ($objects as $number => $object) {
            $offsets[$number] = strlen($pdf);
            $pdf .= "{$number} 0 obj\n{$object}\nendobj\n";
        }

        $xref = strlen($pdf);
        $size = count($objects) + 1;
        $pdf .= "xref\n0 {$size}\n0000000000 65535 f \n";

        foreach ($offsets as $offset) {
            $pdf .= sprintf("%010d 00000 n \n", $offset);
        }

        return $pdf."trailer\n<< /Size {$size} /Root 1 0 R >>\nstartxref\n{$xref}\n%%EOF\n";
    }

    /**
     * An image XObject holding 8-bit samples.
     *
     * @param string $colorSpace `DeviceRGB` or `DeviceGray`.
     * @param string $samples    The samples, compressed with zlib, which is what `/FlateDecode` reads.
     * @param string $extra      More dictionary entries, each with a leading space.
     */
    private static function image(int $width, int $height, string $colorSpace, string $samples, string $extra): string
    {
        return self::stream(
            "<< /Type /XObject /Subtype /Image /Width {$width} /Height {$height} /ColorSpace /{$colorSpace} /BitsPerComponent 8 /Filter /FlateDecode{$extra}",
            $samples,
        );
    }

    /**
     * A stream object: its dictionary, which this closes after adding the length, and its data.
     *
     * @param string $dictionary The dictionary, opened but not closed.
     */
    private static function stream(string $dictionary, string $data): string
    {
        return $dictionary.' /Length '.strlen($data)." >>\nstream\n{$data}\nendstream";
    }
}
