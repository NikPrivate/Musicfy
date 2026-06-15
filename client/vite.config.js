import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// During dev, proxy API + socket traffic to the Node server on :4000 so the
// frontend can run on :5173 with hot reload.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000',
      '/socket.io': { target: 'http://localhost:4000', ws: true },
    },
  },
});
