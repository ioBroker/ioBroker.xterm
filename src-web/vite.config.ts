import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    root: '.',
    base: './',
    build: {
        outDir: '../public',
        emptyOutDir: true,
        sourcemap: true,
        minify: false,
    },
    server: {
        proxy: {
            '/ws': {
                target: 'ws://localhost:8099',
                ws: true,
            },
        },
    },
});
