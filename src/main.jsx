import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
// app.css is NOT imported here on purpose. index.html links the compiled stylesheet
// directly; importing it would make esbuild emit its own dist/app.css and clobber the
// Tailwind CLI output with the unprocessed @tailwind directives.

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
