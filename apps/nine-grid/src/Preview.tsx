import { useEffect, useRef } from 'react';
import { drawGrid } from './engine';
import type { GridPage, PhotoAsset, Settings } from './types';

interface Props { page: GridPage; assets: PhotoAsset[]; settings: Settings; size?: number; className?: string; onError?: (message: string) => void }
export function Preview({ page, assets, settings, size = 1200, className, onError }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  useEffect(() => {
    let active = true;
    if (ref.current) void drawGrid(ref.current, page, assets, settings, size).catch(() => {
      if (active) errorHandler.current?.('图片预览失败，请重新上传这张照片。');
    });
    return () => { active = false; };
  }, [page, assets, settings, size]);
  return <canvas className={className} ref={ref} width={size} height={size} aria-label={`${page.name}预览`} />;
}
