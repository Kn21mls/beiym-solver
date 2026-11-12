import browser from 'webextension-polyfill';
import { SolverError } from '../shared/errors';
import type { CaptureResponse, ImageResult } from '../shared/messages';
import { all, wait } from './dom';

function waitForImage(image: HTMLImageElement): Promise<void> {
  if (image.complete && image.naturalWidth > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new SolverError('Изображение задания ещё не загрузилось.'));
    }, 10000);
    const done = () => {
      cleanup();
      if (image.naturalWidth > 0) resolve();
      else reject(new SolverError('Не удалось загрузить изображение задания.'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      image.removeEventListener('load', done);
      image.removeEventListener('error', done);
    };
    image.addEventListener('load', done, { once: true });
    image.addEventListener('error', done, { once: true });
  });
}

async function sourceOf(element: Element, max: number): Promise<{ source: CanvasImageSource; width: number; height: number }> {
  if (element instanceof HTMLImageElement) {
    await waitForImage(element);
    return { source: element, width: element.naturalWidth, height: element.naturalHeight };
  }
  if (element instanceof HTMLCanvasElement) {
    return { source: element, width: element.width, height: element.height };
  }
  if (element instanceof SVGSVGElement) {
    const markup = new XMLSerializer().serializeToString(element);
    const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      return { source: image, width: image.naturalWidth, height: image.naturalHeight };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  throw new SolverError('Не найден рисунок задания.');
}

function draw(source: CanvasImageSource, width: number, height: number, max: number): ImageResult {
  const ratio = Math.min(1, max / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  const context = canvas.getContext('2d');
  if (!context) throw new SolverError('Не удалось подготовить изображение.');
  context.fillStyle = 'white';
  context.fillRect(0, 0, canvas.width, canvas.height);
  try {
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    return { dataUrl: canvas.toDataURL('image/jpeg', 0.9), width: canvas.width, height: canvas.height };
  } catch (error) {
    console.error('Beyim Solver image draw', error);
    throw new SolverError('Не удалось прочитать изображение задания. Попробуйте выделить блок через селектор.');
  }
}

function drawRegion(
  source: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  max: number,
): ImageResult {
  const ratio = Math.min(1, max / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw * ratio));
  canvas.height = Math.max(1, Math.round(sh * ratio));
  const context = canvas.getContext('2d');
  if (!context) throw new SolverError('Не удалось подготовить изображение.');
  context.fillStyle = 'white';
  context.fillRect(0, 0, canvas.width, canvas.height);
  try {
    context.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return { dataUrl: canvas.toDataURL('image/jpeg', 0.9), width: canvas.width, height: canvas.height };
  } catch (error) {
    console.error('Beyim Solver image crop', error);
    throw new SolverError('Не удалось обрезать снимок задания.');
  }
}

async function screenshot(element: Element, max: number): Promise<ImageResult> {
  element.scrollIntoView({ block: 'center', inline: 'center' });
  await wait(350);
  const rect = element.getBoundingClientRect();
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  if (rect.width < 1 || rect.height < 1) throw new SolverError('Рисунок имеет нулевой размер.');
  if (rect.left < 0 || rect.top < 0 || rect.right > viewport.width || rect.bottom > viewport.height) {
    throw new SolverError('Рисунок не помещается в окно. Уменьшите масштаб Beyim и повторите разбор.');
  }
  const response = (await browser.runtime.sendMessage({ type: 'capture' })) as CaptureResponse;
  if (!response?.ok) {
    throw new SolverError(response?.error || 'Не удалось сделать снимок задания.');
  }
  const after = element.getBoundingClientRect();
  const bounds = ['left', 'top', 'width', 'height'] as const;
  if (!element.isConnected || bounds.some((key) => Math.abs(after[key] - rect[key]) > 1)) {
    throw new SolverError('Рисунок сместился. Остановите прокрутку и повторите разбор.');
  }
  const image = new Image();
  image.src = response.dataUrl;
  await image.decode();
  const scaleX = image.naturalWidth / viewport.width;
  const scaleY = image.naturalHeight / viewport.height;
  const sx = Math.max(0, Math.min(image.naturalWidth - 1, rect.left * scaleX));
  const sy = Math.max(0, Math.min(image.naturalHeight - 1, rect.top * scaleY));
  const sw = Math.min(image.naturalWidth - sx, rect.width * scaleX);
  const sh = Math.min(image.naturalHeight - sy, rect.height * scaleY);
  if (sw < 1 || sh < 1) throw new SolverError('Рисунок находится вне видимой области.');
  return drawRegion(image, sx, sy, sw, sh, max);
}

export async function captureImage(root: Element, max: number): Promise<ImageResult> {
  const images = all(root, 'img,canvas,svg')
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width >= 80 && rect.height >= 60;
    })
    .sort((left, right) => {
      const a = left.getBoundingClientRect();
      const b = right.getBoundingClientRect();
      return b.width * b.height - a.width * a.height;
    });
  if (!images.length) throw new SolverError('В задании не найден рисунок.');
  const limit = Math.min(2000, Math.max(256, max));
  try {
    const { source, width, height } = await sourceOf(images[0], limit);
    return draw(source, width, height, limit);
  } catch (error) {
    console.warn('Beyim Solver image fallback', error);
    try {
      return await screenshot(images[0], limit);
    } catch (fallbackError) {
      console.error('Beyim Solver screenshot fallback', fallbackError);
      const detail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new SolverError(`Не удалось прочитать изображение задания. ${detail}`);
    }
  }
}
