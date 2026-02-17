/**
 * Wraps an async route handler to automatically catch errors
 * and pass them to Express error middleware.
 * Eliminates the need for try-catch in every route.
 *
 * Usage: router.get("/path", asyncHandler(async (req, res) => { ... }));
 */
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
