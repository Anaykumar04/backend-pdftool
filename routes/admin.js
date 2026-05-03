const express = require('express');
const router = express.Router();
const User = require('../models/User');
const History = require('../models/History');
const { protect, adminOnly } = require('../middleware/auth');

// ==================== GET STATS ====================
router.get('/stats', protect, adminOnly, async (req, res) => {
  try {
    const totalUsersCount = await User.countDocuments();
    const historyDocs = await History.find().populate('userId', 'name email').sort({ createdAt: -1 });
    const totalFilesProcessed = historyDocs.length;
    const usersList = await User.find({}, '-password').sort({ createdAt: -1 });

    const conversionOperations = ['pdf-to-jpg', 'jpg-to-pdf', 'pdf-to-word', 'word-to-pdf', 'image-to-pdf', 'word-to-pdf'];
    const totalConversions = historyDocs.filter(h => conversionOperations.includes(h.operation)).length;

    let totalStorageUsed = 0;
    historyDocs.forEach(h => {
      totalStorageUsed += (h.outputFile?.size || 0);
      h.inputFiles?.forEach(f => { totalStorageUsed += (f.size || 0); });
    });

    // Last 7 days chart data
    const filesProcessedOverview = [];
    const today = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const startOfDay = new Date(d); startOfDay.setHours(0,0,0,0);
      const endOfDay = new Date(d); endOfDay.setHours(23,59,59,999);
      const count = historyDocs.filter(h => {
        const hDate = new Date(h.createdAt);
        return hDate >= startOfDay && hDate <= endOfDay;
      }).length;
      filesProcessedOverview.push({
        name: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        count
      });
    }

    // Top tools usage
    const toolsUsageMap = {};
    historyDocs.forEach(h => {
      const op = h.operation || 'unknown';
      toolsUsageMap[op] = (toolsUsageMap[op] || 0) + 1;
    });
    const COLORS = ['#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#6366f1', '#14b8a6'];
    const topToolsUsage = Object.keys(toolsUsageMap)
      .map((op, index) => ({
        name: op.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
        value: toolsUsageMap[op],
        color: COLORS[index % COLORS.length]
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 7);

    const recentFiles = historyDocs.slice(0, 20).map(h => ({
      id: h._id,
      fileName: h.outputFile?.filename || h.outputFile?.name || h.inputFiles?.[0]?.name || 'Unknown File',
      user: h.userId?.name || 'Guest User',
      userEmail: h.userId?.email || '',
      toolUsed: (h.operation || 'unknown').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
      size: h.outputFile?.size || 0,
      date: h.createdAt,
      url: h.outputFile?.url
    }));

    const recentActivity = historyDocs.slice(0, 15).map(h => ({
      id: h._id,
      user: h.userId?.name || 'Guest',
      action: `${(h.operation || 'unknown').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')} applied to ${h.outputFile?.filename || h.inputFiles?.[0]?.name || 'a file'}`,
      time: h.createdAt
    }));

    res.json({
      totalUsers: totalUsersCount,
      totalFilesProcessed,
      totalConversions,
      storageUsed: totalStorageUsed,
      filesProcessedOverview,
      topToolsUsage,
      recentFiles,
      recentActivity,
      usersList,
    });
  } catch (error) {
    console.error('Error fetching admin stats:', error);
    res.status(500).json({ message: 'Error fetching stats' });
  }
});

// ==================== GET ALL USERS ====================
router.get('/users', protect, adminOnly, async (req, res) => {
  try {
    const users = await User.find({}, '-password').sort({ createdAt: -1 });
    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== EDIT USER ====================
router.put('/users/:id', protect, adminOnly, async (req, res) => {
  try {
    const { name, email, role, plan, isVerified } = req.body;
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (name !== undefined) user.name = name;
    if (email !== undefined) user.email = email;
    if (role !== undefined) user.role = role;
    if (plan !== undefined) user.plan = plan;
    if (isVerified !== undefined) user.isVerified = isVerified;
    await user.save();
    const updated = user.toObject();
    delete updated.password;
    res.json({ success: true, user: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== DELETE USER ====================
router.delete('/users/:id', protect, adminOnly, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    // Prevent deleting yourself
    if (user._id.toString() === req.user._id.toString()) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    await User.findByIdAndDelete(req.params.id);
    await History.deleteMany({ userId: req.params.id });
    res.json({ success: true, message: 'User deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== DELETE HISTORY ITEM (admin) ====================
router.delete('/history/:id', protect, adminOnly, async (req, res) => {
  try {
    await History.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'History item deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

