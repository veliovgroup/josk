import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';

const nodeGlobals = {
  Buffer: 'readonly',
  console: 'readonly',
  process: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  globalThis: 'readonly'
};

const mochaGlobals = {
  describe: 'readonly',
  it: 'readonly',
  before: 'readonly',
  after: 'readonly',
  beforeEach: 'readonly',
  afterEach: 'readonly'
};

export default [
  {
    ignores: ['index.cjs', 'coverage/', 'node_modules/', '.types-tmp/', 'articles/', 'docs/', '**/*.d.ts', '**/*.d.cts', 'test/types/', 'test/meteor-types.ts']
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    plugins: { '@stylistic': stylistic },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: nodeGlobals
    },
    rules: {
      'no-shadow': 'error',
      'no-unused-vars': ['error', { vars: 'local', args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-use-before-define': ['error', 'nofunc'],
      'no-cond-assign': ['error', 'always'],
      'no-console': 'off',
      'no-constant-condition': ['error', { checkLoops: false }],
      'consistent-return': 'error',
      curly: ['error', 'multi-line'],
      'default-case': 'error',
      'dot-notation': 'error',
      eqeqeq: 'error',
      'guard-for-in': 'error',
      'no-caller': 'error',
      'no-else-return': 'error',
      'no-eq-null': 'error',
      'no-eval': 'error',
      'no-extend-native': 'error',
      'no-extra-bind': 'error',
      'no-implied-eval': 'error',
      'no-lone-blocks': 'error',
      'no-loop-func': 'error',
      'no-multi-str': 'error',
      'no-new': 'error',
      'no-new-func': 'error',
      'no-new-wrappers': 'error',
      'no-octal-escape': 'error',
      'no-param-reassign': 'error',
      'no-proto': 'error',
      'no-return-assign': 'error',
      'no-script-url': 'error',
      'no-self-compare': 'error',
      'no-sequences': 'error',
      'no-throw-literal': 'error',
      'no-nested-ternary': 'error',
      'no-object-constructor': 'error',
      'no-array-constructor': 'error',
      'one-var': ['error', 'never'],
      'new-cap': ['error', { newIsCap: true }],
      camelcase: ['error', { properties: 'never' }],
      yoda: 'error',
      '@stylistic/indent': ['error', 2, { SwitchCase: 1 }],
      '@stylistic/brace-style': ['error', '1tbs', { allowSingleLine: true }],
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true, allowTemplateLiterals: 'always' }],
      '@stylistic/semi': ['error', 'always'],
      '@stylistic/semi-spacing': ['error', { before: false, after: true }],
      '@stylistic/comma-spacing': ['error', { before: false, after: true }],
      '@stylistic/comma-style': ['error', 'last'],
      '@stylistic/eol-last': 'error',
      '@stylistic/key-spacing': ['error', { beforeColon: false, afterColon: true }],
      '@stylistic/no-multiple-empty-lines': ['error', { max: 2 }],
      '@stylistic/no-trailing-spaces': 'error',
      '@stylistic/padded-blocks': ['error', 'never'],
      '@stylistic/space-infix-ops': 'error',
      '@stylistic/no-floating-decimal': 'error',
      '@stylistic/wrap-iife': ['error', 'any']
    }
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: { ...nodeGlobals, ...mochaGlobals }
    },
    rules: {
      'consistent-return': 'off',
      'no-loop-func': 'off',
      'no-new': 'off',
      'no-shadow': ['error', { allow: ['before', 'after', 'createCluster'] }]
    }
  },
  {
    files: ['test/meteor*.js', 'package.js'],
    languageOptions: {
      globals: { Meteor: 'readonly', Package: 'readonly', Npm: 'readonly', Assets: 'readonly', process: 'readonly' }
    }
  }
];
