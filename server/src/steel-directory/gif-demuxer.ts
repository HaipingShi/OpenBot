/**
 * GIF Demuxer & Filmstrip Stitcher
 * 
 * Unpacks multi-frame animated GIFs (common in B2B steel portal banner ads),
 * extracts representative scene keyframes, and stitches them vertically into
 * a single high-resolution composite filmstrip PNG.
 * 
 * This enables multimodal vision models (e.g. PaddlePaddle/PaddleOCR-VL-1.5,
 * Qwen3-VL) to read rotating company logos, slogans, product catalogs, and direct
 * contact phone numbers across ALL animation frames in a single API call with zero extra cost.
 */

// @ts-ignore
import { GifReader } from "omggif";
// @ts-ignore
import { PNG } from "pngjs";

export interface DemuxResult {
  isAnimated: boolean;
  frameCount: number;
  stitchedPngBuffer: Buffer;
  width: number;
  height: number;
  selectedFrameIndices: number[];
}

export function isGifBuffer(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 6) return false;
  const sig = buffer.subarray(0, 6).toString("ascii");
  return sig === "GIF87a" || sig === "GIF89a";
}

/**
 * Select representative keyframes from a GIF.
 * Steel ads usually have 2-4 key transition slides (Logo -> Products -> Phones -> Slogan).
 */
function selectKeyframeIndices(totalFrames: number, maxFrames: number = 4): number[] {
  if (totalFrames <= 1) return [0];
  if (totalFrames <= maxFrames) {
    return Array.from({ length: totalFrames }, (_, i) => i);
  }

  // Pick evenly spaced frames to capture scene changes
  const step = (totalFrames - 1) / (maxFrames - 1);
  const indices: number[] = [];
  for (let i = 0; i < maxFrames; i++) {
    const idx = Math.min(totalFrames - 1, Math.round(i * step));
    if (!indices.includes(idx)) {
      indices.push(idx);
    }
  }
  return indices;
}

/**
 * Demux an animated GIF into keyframes and stitch them vertically into a single PNG filmstrip.
 */
export function demuxAndStitchGif(
  gifBuffer: Buffer,
  options?: {
    maxKeyframes?: number;
    separatorHeight?: number;
  },
): DemuxResult | null {
  if (!isGifBuffer(gifBuffer)) return null;

  try {
    const reader = new GifReader(gifBuffer);
    const totalFrames = reader.numFrames();
    const width = reader.width;
    const height = reader.height;

    if (totalFrames <= 1) {
      // Single frame GIF - convert directly to PNG
      const png = new PNG({ width, height });
      reader.decodeAndBlitFrameRGBA(0, png.data);
      const stitchedPngBuffer = PNG.sync.write(png);
      return {
        isAnimated: false,
        frameCount: 1,
        stitchedPngBuffer,
        width,
        height,
        selectedFrameIndices: [0],
      };
    }

    const maxKeyframes = options?.maxKeyframes ?? 4;
    const separatorHeight = options?.separatorHeight ?? 4;
    const selectedIndices = selectKeyframeIndices(totalFrames, maxKeyframes);
    const numSelected = selectedIndices.length;

    const totalHeight = height * numSelected + separatorHeight * (numSelected - 1);
    const compositePng = new PNG({ width, height: totalHeight });

    // Fill background with subtle white/neutral separator
    compositePng.data.fill(240);

    for (let sIdx = 0; sIdx < numSelected; sIdx++) {
      const frameIdx = selectedIndices[sIdx];
      const frameData = new Uint8Array(width * height * 4);
      reader.decodeAndBlitFrameRGBA(frameIdx, frameData);

      const yOffset = sIdx * (height + separatorHeight);

      // Copy frame RGBA into composite PNG buffer row by row
      for (let y = 0; y < height; y++) {
        const srcRowStart = y * width * 4;
        const destRowStart = (yOffset + y) * width * 4;
        compositePng.data.set(
          frameData.subarray(srcRowStart, srcRowStart + width * 4),
          destRowStart,
        );
      }
    }

    const stitchedPngBuffer = PNG.sync.write(compositePng);

    return {
      isAnimated: true,
      frameCount: totalFrames,
      stitchedPngBuffer,
      width,
      height: totalHeight,
      selectedFrameIndices: selectedIndices,
    };
  } catch (err: any) {
    console.warn(`[GifDemuxer] Failed to demux GIF: ${err.message}`);
    return null;
  }
}
