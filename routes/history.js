const express = require('express');
const router = express.Router();
const History = require('../models/History');
const { protect } = require('../middleware/auth');

// Get user history
router.get('/', protect, async (req, res) => {
  try {
    const history = await History.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .limit(50);
    res.json({ success: true, history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete history item
router.delete('/:id', protect, async (req, res) => {
  try {
    await History.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    res.json({ success: true, message: 'History item deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
