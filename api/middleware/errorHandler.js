// ---------------------------------------------------------------------------
// Central error handler.
//
// Two rules drive the shape of this file:
//
//  1. Only errors we raised deliberately carry a statusCode, and their messages are
//     written for the caller ("\"tags\" exceeds 20 entries"). Everything else is an
//     escaped exception whose message describes our internals — better-sqlite3 alone
//     will happily tell an anonymous caller "UNIQUE constraint failed: queries.id",
//     naming the table and column. 5xx therefore gets a fixed generic body; the real
//     message stays in the pod log where it is useful and not attacker-readable.
//
//  2. Behind Cloudflare Access every request is a human, but the log is still a shared
//     resource: a loop of malformed JSON would otherwise write a full stack trace per
//     request. 4xx is one line, 5xx keeps the trace.
// ---------------------------------------------------------------------------

const GENERIC_5XX_MESSAGE = 'Internal Server Error';

/** http-errors (body-parser) sets .status, our own helpers set .statusCode. */
function resolveStatus(err) {
  const candidate = err.statusCode ?? err.status;
  if (Number.isInteger(candidate) && candidate >= 400 && candidate <= 599) return candidate;
  return 500;
}

function errorHandler(err, req, res, next) {
  const statusCode = resolveStatus(err);
  const isClientError = statusCode < 500;
  const stamp = new Date().toISOString();
  const where = `${req.method} ${req.originalUrl}`;

  if (isClientError) {
    console.warn(`[${stamp}] ${where} -> ${statusCode}: ${err.message}`);
  } else {
    console.error(`[${stamp}] ${where} -> ${statusCode}: ${err.message}`);
    console.error(err.stack);
  }

  // A handler that already streamed part of a response cannot be given a JSON body on
  // top of it; express' default handler is the only thing that can tidy this up, by
  // destroying the socket so the client sees a truncated response rather than garbage.
  if (res.headersSent) return next(err);

  return res.status(statusCode).json({
    error: isClientError ? err.message : GENERIC_5XX_MESSAGE,
  });
}

module.exports = errorHandler;
module.exports.GENERIC_5XX_MESSAGE = GENERIC_5XX_MESSAGE;
