import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', 'VITE_');
  const isProd = mode === 'production';
  
  return {
    root: '.',
    plugins: [tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      'process.env.NODE_ENV': JSON.stringify(mode),
      'process.env.VITE_SUPABASE_URL': JSON.stringify(env.VITE_SUPABASE_URL),
      'process.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(env.VITE_SUPABASE_ANON_KEY),
      'process.env.VITE_CLOUDINARY_CLOUD_NAME': JSON.stringify(env.VITE_CLOUDINARY_CLOUD_NAME),
      'process.env.VITE_CLOUDINARY_UPLOAD_PRESET': JSON.stringify(env.VITE_CLOUDINARY_UPLOAD_PRESET),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      host: '0.0.0.0',
      port: Number(process.env.PORT || process.env.VITE_PORT || 3000),
      strictPort: false,
      // Disable HMR in production/embed environments
      // Keep HMR enabled in dev mode for localhost development
      hmr: process.env.DISABLE_HMR === 'true' || isProd ? false : {
        host: 'localhost',
        port: Number(process.env.VITE_PORT || 3000),
        protocol: 'ws',
      },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: false,
      minify: 'esbuild',
      // CSP-compatible build configuration
      // - No external scripts injected (no @vite/client, react-refresh, etc.)
      // - No data: URLs for styles (CSS is inlined or external)
      // - No eval() or dynamic imports that require import.meta
      reportCompressedSize: false,
    },
    // Optimize dependencies
    optimizeDeps: {
      exclude: ['@supabase/supabase-js', 'lucide-react', 'motion'],
    },
  };
});
