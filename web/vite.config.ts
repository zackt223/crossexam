import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // The site's playground runs the CLI's own claim detector (../cli/src/claims.js).
  server: { port: 5291, fs: { allow: ['..'] } },
});
