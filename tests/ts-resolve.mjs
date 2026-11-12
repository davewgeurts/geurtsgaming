/**
 * Lets Node run the game's TypeScript directly for `npm test`.
 * Node strips the types by itself; all this adds is finding `./core` when the file is `./core.ts`,
 * which is how the source (bundled by Astro) writes its imports.
 */
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL && !/\.[cm]?[jt]s$/.test(specifier)) {
      if (existsSync(fileURLToPath(new URL(`${specifier}.ts`, context.parentURL)))) return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});
