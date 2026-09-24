<?php

declare(strict_types=1);

namespace PdfConverter;

/**
 * Converts an image into a single-page PDF whose page is exactly the size of the image.
 *
 * One pixel becomes one point, as in the ReportLab script this was ported from. Any format GD can read
 * works (PNG, JPEG, GIF, WebP, BMP and AVIF). Transparency is kept as a soft mask, so transparent areas
 * show the white page; GD stores alpha in 7 bits, so it is kept to within one step of 255.
 *
 * Needs only the gd and zlib extensions, which PHP ships with.
 */
final class ImageToPdf
{
    /**
     * Converts an image file and writes the PDF.
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
        $pdf = self::fromFile($imagePath);

        if (false === @file_put_contents($pdfPath, $pdf)) {
            throw new \RuntimeException("Could not write {$pdfPath}.");
        }

        return $pdfPath;
    }

    /**
     * Converts an image file into the bytes of a PDF.
     *
     * @param string $imagePath The image to convert.
     *
     * @throws \RuntimeException         The image could not be read.
     * @throws \InvalidArgumentException The file is not an image GD can read.
     */
    public static function fromFile(string $imagePath): string
    {
        $bytes = is_file($imagePath) ? @file_get_contents($imagePath) : false;

        if (false === $bytes) {
            throw new \RuntimeException("Could not read {$imagePath}.");
        }

        return self::fromString($bytes, $imagePath);
    }

    /**
     * Converts image bytes into the bytes of a PDF.
     *
     * @param string $bytes The image file's contents.
     * @param string $name  What to call the image in an error message.
     *
     * @throws \InvalidArgumentException The bytes are not an image GD can read.
     */
    public static function fromString(string $bytes, string $name = 'The image'): string
    {
        $image = '' === $bytes ? false : @imagecreatefromstring($bytes);

        if (false === $image) {
            throw new \InvalidArgumentException("{$name} is not an image GD can read (PNG, JPEG, GIF, WebP, BMP or AVIF).");
        }

        [$rgb, $alpha] = self::samples($image);

        return self::document(imagesx($image), imagesy($image), $rgb, $alpha);
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
     * Builds a one-page PDF that draws the image across the whole page.
     *
     * @param int     $width  The image's width in pixels, and the page's in points.
     * @param int     $height The image's height in pixels, and the page's in points.
     * @param string  $rgb    8-bit RGB samples, top row first, compressed with zlib.
     * @param ?string $alpha  8-bit alpha samples, compressed with zlib, or null for an opaque image.
     */
    private static function document(int $width, int $height, string $rgb, ?string $alpha): string
    {
        $objects = [
            1 => '<< /Type /Catalog /Pages 2 0 R >>',
            2 => '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            3 => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {$width} {$height}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>",
            4 => self::image($width, $height, 'DeviceRGB', $rgb, null === $alpha ? '' : ' /SMask 6 0 R'),
            // Scale the unit-square image to the page.
            5 => self::stream('<<', "q {$width} 0 0 {$height} 0 0 cm /Im0 Do Q"),
        ];

        if (null !== $alpha) {
            $objects[6] = self::image($width, $height, 'DeviceGray', $alpha, '');
        }

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
            $samples
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
