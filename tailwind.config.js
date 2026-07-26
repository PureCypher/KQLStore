/** @type {import('tailwindcss').Config} */
// Content globs must cover every file that can contain a class name. All class names in this
// project are written as literals (the two template-literal classNames still interpolate whole
// literal strings), so no safelist is required — but check that if you add computed classes.
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: { extend: {} },
  plugins: [],
};
