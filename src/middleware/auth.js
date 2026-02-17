/**
 * Auth middleware — JWT-only authentication (no legacy query-param fallback).
 * verifyToken must run first and set req.userId / req.userRole / req.user.
 */

/**
 * Require seeker. Rejects if not JWT-authenticated or not a seeker.
 */
export function requireSeeker(req, res, next) {
  if (!req.userId || !req.user) {
    return res.status(401).json({ detail: "Authentication required" });
  }
  if (req.userRole !== "seeker") {
    return res.status(403).json({ detail: "Only job seekers can perform this action" });
  }
  req.seekerId = req.userId;
  req.seeker = req.user;
  next();
}

/**
 * Require employer. Rejects if not JWT-authenticated or not an employer.
 */
export function requireEmployer(req, res, next) {
  if (!req.userId || !req.user) {
    return res.status(401).json({ detail: "Authentication required" });
  }
  if (req.userRole !== "employer") {
    return res.status(403).json({ detail: "Only employers can perform this action" });
  }
  req.employerId = req.userId;
  req.employer = req.user;
  next();
}

/**
 * Require any authenticated user. Rejects if not JWT-authenticated.
 */
export function requireUser(req, res, next) {
  if (!req.userId || !req.user) {
    return res.status(401).json({ detail: "Authentication required" });
  }
  next();
}
