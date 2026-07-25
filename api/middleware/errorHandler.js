function errorHandler(err, req, res, _next) {
  console.error(`[${new Date().toISOString()}] Error:`, err.message);
  console.error(err.stack);

  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    error: err.message || 'Internal Server Error',
  });
}

module.exports = errorHandler;
