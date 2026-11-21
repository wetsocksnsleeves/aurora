import { MAX_IMAGE_SIDE, type ImageShape } from "@/lib/types";

/**
 * Ask for a picture and shrink it to an image clip's pixels: at most
 * `MAX_IMAGE_SIDE` on its long side, as "rrggbbaa" hex. Must run from a
 * click: browsers only open the file picker for a user gesture. Resolves
 * null if nothing was picked.
 */
export function pickImage(): Promise<ImageShape | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      imageFromFile(file).then(resolve, reject);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

async function imageFromFile(file: File): Promise<ImageShape> {
  const bitmap = await createImageBitmap(file);
  const k = MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height);
  const w = Math.max(1, Math.round(bitmap.width * Math.min(1, k)));
  const h = Math.max(1, Math.round(bitmap.height * Math.min(1, k)));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const data = ctx.getImageData(0, 0, w, h).data;
  let pixels = "";
  for (let i = 0; i < data.length; i++) {
    pixels += data[i]!.toString(16).padStart(2, "0");
  }
  return { kind: "image", w, h, pixels, fit: "cover" };
}
