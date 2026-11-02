import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactRefresh.configs.vite,
    ],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      // The plugin's v7 presets also enable the React Compiler rules. Keep the
      // hook rules this project already used instead of adopting them here.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // These exports sit beside their components and were accepted by the
      // previous plugin release; name them rather than relaxing the whole rule.
      'react-refresh/only-export-components': [
        'error',
        {
          allowConstantExport: true,
          allowCompoundComponents: true,
          allowExportNames: ['ICON_SIZES', 'FILTER_EXPLANATIONS', 'filterIcon'],
        },
      ],
    },
    languageOptions: {
      globals: globals.browser,
    },
  },
])
