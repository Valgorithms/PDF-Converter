<?php

declare(strict_types=1);

namespace PdfConverter\Tests;

use PdfConverter\ImageToPdf;
use PHPUnit\Framework\TestCase;

final class ImageToPdfTest extends TestCase
{
    public function testTheImageFillsAPageTheSizeOfTheImage(): void
    {
        $pdf = ImageToPdf::fromString($this->png(function (\GdImage $image) {
            imagesetpixel($image, 0, 0, imagecolorallocate($image, 255, 0, 0));
            imagesetpixel($image, 2, 1, imagecolorallocate($image, 0, 0, 255));
        }, 3, 2));

        $this->assertStringStartsWith('%PDF-1.4', $pdf);
        $this->assertStringContainsString('/MediaBox [0 0 3 2]', $this->object($pdf, 3)[0]);
        $this->assertSame('q 3 0 0 2 0 0 cm /Im0 Do Q', $this->object($pdf, 5)[1]);

        [$image, $samples] = $this->object($pdf, 4);
        $this->assertStringContainsString('/Width 3 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8', $image);
        $this->assertStringNotContainsString('/SMask', $image, 'an opaque image needs no mask');
        // Top row first: red, black, black; then black, black, blue.
        $this->assertSame("\xFF\0\0".str_repeat("\0", 12)."\0\0\xFF", gzuncompress($samples));
    }

    public function testTransparencyBecomesASoftMask(): void
    {
        $pdf = ImageToPdf::fromString($this->png(function (\GdImage $image) {
            imagealphablending($image, false);
            imagesetpixel($image, 0, 0, imagecolorallocatealpha($image, 10, 20, 30, 127));
            imagesetpixel($image, 1, 0, imagecolorallocatealpha($image, 10, 20, 30, 64));
            imagesetpixel($image, 2, 0, imagecolorallocatealpha($image, 10, 20, 30, 0));
        }, 3, 1));

        $this->assertStringContainsString('/SMask 6 0 R', $this->object($pdf, 4)[0]);

        [$mask, $alpha] = $this->object($pdf, 6);
        $this->assertStringContainsString('/ColorSpace /DeviceGray', $mask);
        $this->assertSame([0, 126, 255], array_values(unpack('C*', gzuncompress($alpha))));
    }

    public function testAPaletteImagesTransparentColourIsMasked(): void
    {
        $image = imagecreate(2, 1);
        $clear = imagecolorallocate($image, 0, 255, 0);
        imagesetpixel($image, 1, 0, imagecolorallocate($image, 255, 255, 255));
        imagecolortransparent($image, $clear);

        ob_start();
        imagegif($image);
        $pdf = ImageToPdf::fromString((string) ob_get_clean());

        $this->assertSame([0, 255], array_values(unpack('C*', gzuncompress($this->object($pdf, 6)[1]))));
    }

    public function testEveryCrossReferencePointsAtItsObject(): void
    {
        $pdf = ImageToPdf::fromString($this->png(static fn () => null, 5, 4));

        preg_match('/startxref\n(\d+)\n%%EOF\n$/', $pdf, $start);
        $table = substr($pdf, (int) $start[1]);
        preg_match_all('/^(\d{10}) 00000 n $/m', $table, $entries);

        $this->assertStringStartsWith("xref\n0 6\n0000000000 65535 f \n", $table);
        $this->assertCount(5, $entries[1]);

        foreach ($entries[1] as $index => $offset) {
            $this->assertStringStartsWith(($index + 1).' 0 obj', substr($pdf, (int) $offset));
        }
    }

    public function testConvertWritesThePdfAndReturnsItsPath(): void
    {
        $image = tempnam(sys_get_temp_dir(), 'img');
        $pdf = $image.'.pdf';
        file_put_contents($image, $this->png(static fn () => null, 2, 2));

        try {
            $this->assertSame($pdf, ImageToPdf::convert($image, $pdf));
            $this->assertStringStartsWith('%PDF-1.4', (string) file_get_contents($pdf));
        } finally {
            @unlink($image);
            @unlink($pdf);
        }
    }

    public function testAFileThatIsNotAnImageIsRefused(): void
    {
        $this->expectException(\InvalidArgumentException::class);

        ImageToPdf::fromString('not an image', 'notes.txt');
    }

    public function testEachImageBecomesAPageInTheOrderGiven(): void
    {
        $pdf = ImageToPdf::fromStrings([
            $this->png(static fn () => null, 3, 2),
            $this->png(static function (\GdImage $image) {
                imagealphablending($image, false);
                imagesetpixel($image, 0, 0, imagecolorallocatealpha($image, 0, 0, 0, 127));
            }, 5, 4),
            $this->png(static fn () => null, 2, 7),
        ]);

        // Page 1 takes objects 3–5, page 2 (with a mask) 6–9, page 3 10–12.
        $this->assertStringContainsString('<< /Type /Pages /Kids [3 0 R 6 0 R 10 0 R] /Count 3 >>', $this->object($pdf, 2)[0]);
        $this->assertSame(['3 2', '5 4', '2 7'], array_map(
            fn (int $page) => preg_match('/\/MediaBox \[0 0 (\d+) (\d+)\]/', $this->object($pdf, $page)[0], $m) ? "{$m[1]} {$m[2]}" : '',
            [3, 6, 10],
        ));
        $this->assertStringContainsString('/Im0 7 0 R', $this->object($pdf, 6)[0], 'each page names its own image');
        $this->assertStringContainsString('/SMask 9 0 R', $this->object($pdf, 7)[0], 'only the image with transparency has a mask');
        $this->assertStringNotContainsString('/SMask', $this->object($pdf, 11)[0]);
        $this->assertSame('q 2 0 0 7 0 0 cm /Im0 Do Q', $this->object($pdf, 12)[1]);
    }

    public function testEveryCrossReferencePointsAtItsObjectOnManyPages(): void
    {
        $pdf = ImageToPdf::fromStrings(array_fill(0, 4, $this->png(static fn () => null, 2, 2)));

        preg_match('/startxref\n(\d+)\n%%EOF\n$/', $pdf, $start);
        preg_match_all('/^(\d{10}) 00000 n $/m', substr($pdf, (int) $start[1]), $entries);

        $this->assertCount(2 + 4 * 3, $entries[1]);
        foreach ($entries[1] as $index => $offset) {
            $this->assertStringStartsWith(($index + 1).' 0 obj', substr($pdf, (int) $offset));
        }
    }

    public function testConvertAllWritesOnePdfOfEveryImage(): void
    {
        $directory = sys_get_temp_dir().'/pdf-converter-'.bin2hex(random_bytes(4));
        mkdir($directory);
        $images = [];
        foreach ([[4, 3], [6, 2]] as $index => [$width, $height]) {
            $images[] = $path = "{$directory}/{$index}.png";
            file_put_contents($path, $this->png(static fn () => null, $width, $height));
        }

        try {
            $this->assertSame("{$directory}/out.pdf", ImageToPdf::convertAll($images, "{$directory}/out.pdf"));
            $this->assertSame(1, preg_match('/\/Count 2 >>/', (string) file_get_contents("{$directory}/out.pdf")));
        } finally {
            array_map('unlink', glob("{$directory}/*"));
            rmdir($directory);
        }
    }

    public function testNoImagesIsRefused(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('There are no images to convert.');

        ImageToPdf::fromStrings([]);
    }

    public function testTheImageThatIsNotAnImageIsNamed(): void
    {
        $png = $this->png(static fn () => null, 2, 2);

        try {
            ImageToPdf::fromStrings([$png, 'not an image']);
            $this->fail('the second image should be refused');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringStartsWith('Image 2 is not an image', $e->getMessage());
        }

        $this->expectExceptionMessage('notes.txt is not an image');
        ImageToPdf::fromStrings([$png, 'not an image'], ['photo.png', 'notes.txt']);
    }

    public function testTheCommandLineTakesSeveralImagesAndAnOutput(): void
    {
        $directory = sys_get_temp_dir().'/pdf-converter-'.bin2hex(random_bytes(4));
        mkdir($directory);
        file_put_contents("{$directory}/a.png", $this->png(static fn () => null, 2, 2));
        file_put_contents("{$directory}/b.png", $this->png(static fn () => null, 3, 3));
        $script = escapeshellarg(PHP_BINARY).' '.escapeshellarg(dirname(__DIR__).'/bin/image-to-pdf');

        try {
            exec("{$script} ".escapeshellarg("{$directory}/a.png").' '.escapeshellarg("{$directory}/b.png").' '.escapeshellarg("{$directory}/both.pdf").' 2>&1', $out, $code);
            $this->assertSame(0, $code, implode("\n", $out));
            $this->assertSame(["{$directory}/both.pdf"], $out);
            $this->assertStringContainsString('/Count 2 >>', (string) file_get_contents("{$directory}/both.pdf"));

            exec("{$script} ".escapeshellarg("{$directory}/a.png").' 2>&1', $single, $code);
            $this->assertSame(["{$directory}/a.pdf"], $single, 'one image still goes beside itself');

            exec("{$script} 2>&1", $usage, $code);
            $this->assertSame(1, $code);
        } finally {
            array_map('unlink', glob("{$directory}/*"));
            rmdir($directory);
        }
    }

    public function testAMissingFileIsReported(): void
    {
        $this->expectException(\RuntimeException::class);

        ImageToPdf::fromFile(sys_get_temp_dir().'/no-such-image.png');
    }

    /**
     * A PNG of a black truecolour canvas, drawn on by `$draw`.
     */
    private function png(callable $draw, int $width, int $height): string
    {
        $image = imagecreatetruecolor($width, $height);
        imagesavealpha($image, true);
        $draw($image);

        ob_start();
        imagepng($image);

        return (string) ob_get_clean();
    }

    /**
     * An object's dictionary, and its stream's data when it has one, sliced by its `/Length`.
     *
     * @return array{0: string, 1: ?string}
     */
    private function object(string $pdf, int $number): array
    {
        $start = strpos($pdf, "\n{$number} 0 obj\n");
        $this->assertNotFalse($start, "object {$number} exists");

        $body = substr($pdf, $start + strlen("\n{$number} 0 obj\n"));

        // Stop at this object's endobj, so an object without a stream never matches the next one's.
        if (! preg_match('/^(<<(?:(?!\nendobj).)*?>>)\nstream\n/s', $body, $head)) {
            return [substr($body, 0, (int) strpos($body, "\nendobj")), null];
        }

        preg_match('/\/Length (\d+)/', $head[1], $length);

        return [$head[1], substr($body, strlen($head[0]), (int) $length[1])];
    }
}
