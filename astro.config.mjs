// @ts-check
import { defineConfig, fontProviders } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  site: 'https://geurtsgaming.com',
  trailingSlash: 'always',
  integrations: [sitemap()],
  vite: {
    server: {
      allowedHosts: ['geurtsgaming.localdev', 'localhost'],
    },
  },
  // Fonts are downloaded at build time and served from this site, so pages make no third-party requests.
  fonts: [
    {
      provider: fontProviders.fontsource(),
      name: 'Nunito',
      cssVariable: '--font-nunito',
      weights: [400, 700, 800],
      styles: ['normal'],
      fallbacks: ['system-ui', 'sans-serif'],
    },
    {
      provider: fontProviders.fontsource(),
      name: 'Orbitron',
      cssVariable: '--font-orbitron',
      weights: [700, 900],
      styles: ['normal'],
      fallbacks: ['system-ui', 'sans-serif'],
    },
  ],
});
