const express = require('express');
const router = express.Router();
const User = require('../models/User');
const History = require('../models/History');
const auth = require('../middleware/auth');

router.get('/stats', auth, async (req, res) => {
  try {
    // 1. Total Users
    const totalUsersCount = await User.countDocuments();
    
    // 2. Total Files Processed (From History)
    const historyDocs = await History.find().populate('userId', 'name').sort({ createdAt: -1 });
    const totalFilesProcessed = historyDocs.length;
    
    // 3. Total Conversions
    const conversionOperations = ['pdf-to-jpg', 'jpg-to-pdf', 'pdf-to-word', 'word-to-pdf', 'pdf-to-excel'];
    const totalConversions = historyDocs.filter(h => conversionOperations.includes(h.operation)).length;

    // 4. Storage Used
    let totalStorageUsed = 0;
    historyDocs.forEach(h => {
      totalStorageUsed += (h.outputFile?.size || 0);
      h.inputFiles?.forEach(f => {
        totalStorageUsed += (f.size || 0);
      });
    });

    // 5. Files Processed Overview (Last 7 days)
    const filesProcessedOverview = [];
    const today = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateString = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      
      const startOfDay = new Date(d.setHours(0,0,0,0));
      const endOfDay = new Date(d.setHours(23,59,59,999));

      const count = historyDocs.filter(h => {
        const hDate = new Date(h.createdAt);
        return hDate >= startOfDay && hDate <= endOfDay;
      }).length;

      filesProcessedOverview.push({ name: dateString, count });
    }

    // 6. Top Tools Usage
    const toolsUsageMap = {};
    historyDocs.forEach(h => {
      toolsUsageMap[h.operation] = (toolsUsageMap[h.operation] || 0) + 1;
    });
    
    let topToolsUsage = Object.keys(toolsUsageMap).map(op => ({
      name: op.charAt(0).toUpperCase() + op.slice(1).replace('-', ' '),
      value: toolsUsageMap[op]
    })).sort((a, b) => b.value - a.value);

    // Map some nice colors for the pie chart
    const COLORS = ['#8884d8', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#6366f1'];
    topToolsUsage = topToolsUsage.map((item, index) => ({
      ...item,
      color: COLORS[index % COLORS.length]
    }));

    // 7. Recent Files & Activity
    const recentFiles = historyDocs.slice(0, 10).map(h => ({
      id: h._id,
      fileName: h.outputFile?.name || h.inputFiles?.[0]?.name || 'Unknown File',
      user: h.userId?.name || 'Guest User',
      toolUsed: h.operation.charAt(0).toUpperCase() + h.operation.slice(1).replace('-', ' '),
      size: h.outputFile?.size || 0,
      date: h.createdAt,
      url: h.outputFile?.url
    }));

    // Generate recent activity stream
    const recentActivity = historyDocs.slice(0, 10).map(h => {
      const tool = h.operation.charAt(0).toUpperCase() + h.operation.slice(1).replace('-', ' ');
      const userName = h.userId?.name || 'Guest';
      const fileName = h.outputFile?.name || h.inputFiles?.[0]?.name || 'a file';
      return {
        id: h._id,
        user: userName,
        action: `${tool} applied to ${fileName}`,
        time: h.createdAt
      };
    });

    res.json({
      totalUsers: totalUsersCount,
      totalFilesProcessed,
      totalConversions,
      storageUsed: totalStorageUsed,
      filesProcessedOverview,
      topToolsUsage,
      recentFiles,
      recentActivity
    });
  } catch (error) {
    console.error('Error fetching admin stats:', error);
    res.status(500).json({ message: 'Error fetching stats' });
  }
});

module.exports = router;
