import { defineConfig } from 'vite';
import { resolve } from 'path';
import { copyFileSync, mkdirSync } from 'fs';

export default defineConfig(({ mode }) => {
  // Check for specific entry point from environment
  const entry = process.env.VITE_ENTRY;
  
  if (entry) {
    // Build single entry as IIFE
    const entryPath = {
      'service-worker': 'src/background/service-worker.ts',
      'content-editor': 'src/content/editor.ts',
      'main-world': 'src/content/main-world.ts',
    }[entry];
    
    if (!entryPath) {
      throw new Error(`Unknown entry: ${entry}`);
    }
    
    return {
      build: {
        outDir: 'dist',
        emptyOutDir: false,
        minify: mode === 'production',
        sourcemap: mode === 'development',
        lib: {
          entry: resolve(__dirname, entryPath),
          formats: ['iife'],
          fileName: () => `${entry}.js`,
          name: entry.replace('-', '_'),
        },
        rollupOptions: {
          output: {
            extend: true,
          },
        },
      },
      define: {
        'process.env.NODE_ENV': JSON.stringify(mode),
      },
    };
  }
  
  // Default build - just copy files using a dummy entry
  return {
    build: {
      outDir: 'dist',
      emptyOutDir: false,
      rollupOptions: {
        input: resolve(__dirname, 'manifest.json'), // Use manifest as dummy entry
        output: {
          entryFileNames: 'dummy.js',
        },
        plugins: [
          {
            name: 'ignore-entry',
            load(id) {
              if (id.includes('manifest.json')) {
                return 'export {}'; // Return empty module
              }
            }
          }
        ]
      },
    },
    plugins: [
      {
        name: 'copy-extension-files',
        writeBundle() {
          // Copy manifest.json
          copyFileSync('manifest.json', 'dist/manifest.json');
          
          // Copy icons
          mkdirSync('dist/icons', { recursive: true });
          copyFileSync('icons/icon16.png', 'dist/icons/icon16.png');
          copyFileSync('icons/icon48.png', 'dist/icons/icon48.png');
          copyFileSync('icons/icon128.png', 'dist/icons/icon128.png');
          
          console.log('✓ Extension files copied to dist/');
        }
      }
    ]
  };
});