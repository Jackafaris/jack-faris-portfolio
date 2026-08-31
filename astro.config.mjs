// @ts-check
import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';

// https://astro.build/config
export default defineConfig({
  // 'server' enables the /api/* serverless function; every page below is
  // explicitly `prerender: true` so they still ship as static HTML.
  output: 'server',
  adapter: vercel(),
  site: 'https://jackfaris.com',
  redirects: {
    '/challenges': '/work',
  },
});
