import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/buy': 'http://localhost:3000',
      '/status': 'http://localhost:3000',
      '/payment': 'http://localhost:3000',
    },
  },
});
