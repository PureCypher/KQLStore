// ---------------------------------------------------------------------------
// ESLint flat configuration.
//
// Named .cjs rather than .js on purpose: the root package.json declares
// "type": "module", so an eslint.config.js would be parsed as ESM and the extension
// is what pins the module system rather than leaving it to inherit a field that
// belongs to the build. The API is CommonJS, the SPA is ESM, and this file has to
// load regardless of which way the root flips.
//
// The rule set is deliberately surgical rather than "extends: recommended" for React.
// The React and React Hooks recommended presets pull in large advisory rule sets
// (prop-types, the React Compiler diagnostics) that would bury the handful of rules
// this repo actually needs under thousands of findings, and a gate nobody can pass is
// a gate nobody reads. eslint's own js.configs.recommended is kept in full — every
// rule in it describes a genuine defect.
//
// The rules that carry their weight, each mapped to a defect that reached production
// in this repo:
//
//   react/no-unstable-nested-components — components declared inside other components
//     are re-created on every render, so React unmounts and remounts the whole
//     subtree instead of updating it. That lost focus from the search box mid-keystroke
//     and discarded in-progress edits in the query editor.
//
//   react-hooks/rules-of-hooks + react-hooks/exhaustive-deps — a hook behind a
//     conditional, or a stale closure in a dependency array, produces state that is
//     wrong rather than absent. That is the failure mode least likely to be caught in
//     review and the one most likely to corrupt a saved query.
// ---------------------------------------------------------------------------

const js = require('@eslint/js');
const globals = require('globals');
const react = require('eslint-plugin-react');
const reactHooks = require('eslint-plugin-react-hooks');

// eslint-plugin-react can sniff the version out of node_modules with 'detect', but that
// makes lint results depend on whether install ran first. Pin it to the version
// package.json pins; none of the rules enabled below are version-sensitive, so this only
// has to stay roughly honest.
const REACT_VERSION = '18.3.1';

// Rules applied to every file, browser and server alike.
const SHARED_RULES = {
  // argsIgnorePattern covers the Express (err, req, res, _next) arity requirement:
  // dropping the fourth parameter turns an error handler into ordinary middleware, so
  // it has to stay declared and unused.
  'no-unused-vars': [
    'error',
    {
      args: 'after-used',
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrors: 'all',
      caughtErrorsIgnorePattern: '^_',
      ignoreRestSiblings: true,
    },
  ],

  // Query records change type as they cross the SQLite boundary — favorite is an
  // INTEGER in the database and a boolean in the SPA, usageCount arrives from form
  // input as a string. == is precisely what hides those mismatches. null is exempted
  // so the idiomatic `x == null` undefined-or-null check stays available.
  eqeqeq: ['error', 'always', { null: 'ignore' }],

  // Bans +x, !!x and '' + x. The same coercion reads as deliberate or accidental
  // depending on the reader, which matters most in the import path, where untrusted
  // JSON from an exported file is being reshaped into records.
  'no-implicit-coercion': ['error', { boolean: true, number: true, string: true }],
};

// React rules shared by every file that can contain JSX.
const REACT_RULES = {
  // The three rules this gate exists for.
  'react/no-unstable-nested-components': ['error', { allowAsProps: false }],
  'react-hooks/rules-of-hooks': 'error',
  'react-hooks/exhaustive-deps': 'error',

  // Marks identifiers referenced only from JSX as used. Without it, no-unused-vars
  // above reports every component and every lucide icon in the repo.
  'react/jsx-uses-vars': 'error',
  // Same job for the React binding itself, which is still imported by the files that
  // predate the automatic JSX runtime.
  'react/jsx-uses-react': 'error',

  // A missing key makes React reuse the wrong DOM node on reorder, which the query
  // list does on every sort and filter change — the symptom is a row showing another
  // row's expanded state, not an error.
  'react/jsx-key': ['error', { checkFragmentShorthand: true }],
  // window.opener on a target=_blank link lets the opened page navigate this one; the
  // app renders links out to Microsoft Learn documentation.
  'react/jsx-no-target-blank': 'error',
};

// Browser runtime for everything the bundler pulls into dist/app.js.
const BROWSER_LANGUAGE_OPTIONS = {
  ecmaVersion: 'latest',
  sourceType: 'module',
  parserOptions: {
    ecmaFeatures: { jsx: true },
  },
  globals: {
    ...globals.browser,
  },
};

module.exports = [
  {
    ignores: [
      '**/node_modules/**',
      // esbuild and tailwind output. dist/app.js is a minified bundle, not source.
      'dist/**',
      // The v8 coverage reporter writes its own vendored prettify.js and sorter.js
      // into here. Unlike dist/ this directory is not in .gitignore, so without this
      // entry a coverage run leaves someone else's minified JavaScript in the lint set.
      'coverage/**',
    ],
  },

  // -------------------------------------------------------------------------
  // SPA sources. ES modules with JSX, bundled by esbuild with the automatic JSX
  // runtime, so react/react-in-jsx-scope is deliberately NOT enabled — under
  // --jsx=automatic an explicit React import is optional and requiring one would
  // report an error on every correct file.
  // -------------------------------------------------------------------------
  {
    files: ['src/**/*.{js,jsx}', '*.jsx'],
    ...js.configs.recommended,
    languageOptions: BROWSER_LANGUAGE_OPTIONS,
    settings: {
      react: { version: REACT_VERSION },
    },
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...SHARED_RULES,
      ...REACT_RULES,
    },
  },

  // -------------------------------------------------------------------------
  // Vitest suites. jsdom supplies the browser globals; the test globals themselves
  // are imported explicitly rather than injected, so only the runner's own escape
  // hatches need relaxing.
  // -------------------------------------------------------------------------
  {
    files: ['src/**/*.{test,spec}.{js,jsx}', 'test/**/*.{js,jsx}', '**/__tests__/**/*.{js,jsx}'],
    languageOptions: {
      ...BROWSER_LANGUAGE_OPTIONS,
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      'no-console': 'off',
    },
  },

  // -------------------------------------------------------------------------
  // API server — CommonJS on Node, no JSX, no React.
  // -------------------------------------------------------------------------
  {
    files: ['api/**/*.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      ...SHARED_RULES,
    },
  },

  // -------------------------------------------------------------------------
  // Build and repo tooling that runs on Node rather than in the browser.
  // -------------------------------------------------------------------------
  {
    files: [
      'scripts/**/*.{js,mjs}',
      'tailwind.config.js',
      'vitest.config.js',
      '.github/scripts/**/*.mjs',
    ],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      ...SHARED_RULES,
      'no-console': 'off',
    },
  },
  {
    files: ['**/*.cjs'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      ...SHARED_RULES,
    },
  },
];
