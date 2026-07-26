// Query identifiers. crypto.randomUUID is available in every secure context; the manual
// fallback covers plain-HTTP origins where it is undefined.

// ============================================================
// UUID Generator
// ============================================================
const generateId = () => {
  // crypto.randomUUID is unavailable on plain-HTTP origins, so keep the manual path.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return   'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
};

export { generateId };
