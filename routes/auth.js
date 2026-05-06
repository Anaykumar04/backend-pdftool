const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { protect } = require('../middleware/auth');
const { OAuth2Client } = require('google-auth-library');
const { sendOTPEmail } = require('../utils/email');

// Initialize lazily so env vars are loaded first
let _client = null;
const getClient = () => {
  if (!_client) _client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
  return _client;
};

const ADMIN_EMAILS = [
  'anayk0699@gmail.com',
  'aa4345915@gmail.com'
];

const generateToken = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '7d' });

const isAdmin = (email) => ADMIN_EMAILS.includes(email.toLowerCase());

// Register
router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields are required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ error: 'Email already registered' });

    const role = isAdmin(email) ? 'admin' : 'user';
    // Admins are auto-verified, regular users need email verification
    const verified = role === 'admin';

    const user = await User.create({ name, email, password, role, isVerified: verified });

    const token = generateToken(user._id);

    // Send OTP only for regular users
    if (!verified) {
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      user.otp = otp;
      user.otpExpires = Date.now() + 10 * 60 * 1000;
      await user.save();
      try {
        await sendOTPEmail(email, otp, name);
      } catch (emailErr) {
        console.error('Email send error:', emailErr.message);
      }
    }

    res.status(201).json({
      success: true,
      token,
      requiresVerification: !verified,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        avatar: user.avatar,
        role: user.role,
        plan: user.plan,
        isVerified: user.isVerified,
        createdAt: user.createdAt
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = await User.findOne({ email });
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // If user is not verified and not admin, send a fresh OTP
    if (!user.isVerified && user.role !== 'admin') {
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      user.otp = otp;
      user.otpExpires = Date.now() + 10 * 60 * 1000;
      await user.save();
      try {
        await sendOTPEmail(email, otp, user.name);
      } catch (emailErr) {
        console.error('Email send error:', emailErr.message);
      }
      return res.json({
        success: true,
        requiresVerification: true,
        token: generateToken(user._id),
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          isVerified: user.isVerified,
        }
      });
    }

    res.json({
      success: true,
      requiresVerification: false,
      token: generateToken(user._id),
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        avatar: user.avatar,
        address: user.address,
        role: user.role,
        plan: user.plan,
        subscriptionEnd: user.subscriptionEnd,
        isVerified: user.isVerified,
        createdAt: user.createdAt
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send OTP (resend)
router.post('/send-otp', async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: 'User not found. Please register first.' });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    user.otp = otp;
    user.otpExpires = Date.now() + 10 * 60 * 1000;
    await user.save();

    try {
      await sendOTPEmail(email, otp, user.name);
    } catch (emailErr) {
      console.error('Email send error:', emailErr.message);
      return res.status(500).json({ error: 'Failed to send OTP email. Please try again.' });
    }

    res.json({ success: true, message: 'OTP sent to your email' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verify OTP
router.post('/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    const user = await User.findOne({ email });

    if (!user || user.otp !== otp || user.otpExpires < Date.now()) {
      return res.status(400).json({ error: 'Invalid or expired OTP' });
    }

    user.isVerified = true;
    user.otp = null;
    user.otpExpires = null;
    await user.save();

    res.json({
      success: true,
      message: 'Email verified successfully',
      token: generateToken(user._id),
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        avatar: user.avatar,
        role: user.role,
        plan: user.plan,
        isVerified: user.isVerified,
        createdAt: user.createdAt
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get current user
router.get('/me', protect, (req, res) => {
  res.json({ success: true, user: req.user });
});

// Update Profile
router.put('/update', protect, async (req, res) => {
  try {
    const { name, email, avatar, address } = req.body;
    const user = await User.findById(req.user._id);
    if (name) user.name = name;
    if (email) user.email = email;
    if (avatar) user.avatar = avatar;
    if (address) user.address = address;
    await user.save();
    res.json({
      success: true,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        avatar: user.avatar,
        address: user.address,
        role: user.role,
        plan: user.plan,
        subscriptionEnd: user.subscriptionEnd,
        createdAt: user.createdAt
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Google Auth — always direct login, no OTP needed
router.post('/google', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token is required' });

    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(500).json({ error: 'Google login is not configured on the server. Please contact support.' });
    }

    const ticket = await getClient().verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const { name, email, picture } = ticket.getPayload();

    let user = await User.findOne({ email });
    if (!user) {
      const role = isAdmin(email) ? 'admin' : 'user';
      user = await User.create({
        name,
        email,
        avatar: picture,
        role,
        isVerified: true,
        password: Math.random().toString(36).slice(-12),
      });
    } else {
      // Always update avatar and ensure verified
      if (picture) user.avatar = picture;
      user.isVerified = true;
      await user.save();
    }

    res.json({
      success: true,
      token: generateToken(user._id),
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        avatar: user.avatar,
        role: user.role,
        plan: user.plan,
        isVerified: user.isVerified,
        createdAt: user.createdAt
      }
    });
  } catch (err) {
    console.error('Google Auth Error:', err.message);
    // Give a more specific error message
    if (err.message?.includes('Token used too late') || err.message?.includes('expired')) {
      return res.status(400).json({ error: 'Google token expired. Please try signing in again.' });
    }
    if (err.message?.includes('Invalid token') || err.message?.includes('audience')) {
      return res.status(400).json({ error: 'Invalid Google token. Make sure GOOGLE_CLIENT_ID is set correctly on the server.' });
    }
    res.status(400).json({ error: 'Google authentication failed: ' + err.message });
  }
});

module.exports = router;

