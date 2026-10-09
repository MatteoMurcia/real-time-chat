import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import ts from 'typescript-eslint';
import angular from 'angular-eslint';
import globals from 'globals';

export default defineConfig(
  globalIgnores(['**/dist/**', '**/dist-test/**', '**/.angular/**', '**/coverage/**', 'apps/api/src/generated/**']),
  { files: ['**/*.mjs'], extends: [js.configs.recommended], languageOptions: { globals: globals.node } },
  { files: ['**/*.ts'], extends: [js.configs.recommended, ...ts.configs.recommended] },
  { files: ['apps/web/**/*.ts'], extends: angular.configs.tsRecommended, processor: angular.processInlineTemplates },
  { files: ['apps/web/**/*.html'], extends: [...angular.configs.templateRecommended, ...angular.configs.templateAccessibility] },
);
