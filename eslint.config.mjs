import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // New in eslint-plugin-react-hooks@7. Flags legit SSR-hydration and
      // capability-detection effects; keep as a warning until those patterns
      // are refactored separately.
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    'scripts/**',
    'infra/**',
    'generate-image-arrays.js',
  ]),
]);

export default eslintConfig;
