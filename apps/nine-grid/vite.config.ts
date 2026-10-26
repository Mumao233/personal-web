import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/nine-grid/',
  resolve: { dedupe: ['react', 'react-dom'] },
  build: { outDir: '../../public/nine-grid', emptyOutDir: true },
});
