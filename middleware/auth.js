const jwt = require('jsonwebtoken');
const User = require('../models/User');

const protect = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(decoded.id).select('-password');
    if (!req.user) return res.status(401).json({ error: 'User not found' });

    // Auto-fix: ensure admin accounts are always marked as verified
    if (req.user.role === 'admin' && !req.user.isVerified) {
      await User.findByIdAndUpdate(req.user._id, { isVerified: true });
      req.user.isVerified = true;
    }

    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

const optionalAuth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = await User.findById(decoded.id).select('-password');
    }
    next();
  } catch (err) {
    next();
  }
};

const adminOnly = (req, res, next) => {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    res.status(403).json({ error: 'Access denied: Admins only' });
  }
};

const verifiedOnly = (req, res, next) => {
  // Admins always have access regardless of isVerified flag
  if (req.user && (req.user.isVerified || req.user.role === 'admin')) {
    next();
  } else {
    res.status(403).json({ error: 'Please verify your email to use this tool' });
  }
};

module.exports = { protect, optionalAuth, adminOnly, verifiedOnly };


