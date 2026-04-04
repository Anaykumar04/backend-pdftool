const mongoose = require('mongoose');

const historySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false },
  sessionId: { type: String },
  operation: {
    type: String,
    enum: ['merge', 'split', 'compress', 'rotate', 'watermark', 'protect', 'unlock', 'pdf-to-jpg', 'jpg-to-pdf', 'pdf-to-word', 'word-to-pdf', 'pdf-to-excel', 'reorder', 'extract-text', 'info'],
    required: true
  },
  inputFiles: [{ name: String, size: Number }],
  outputFile: { name: String, size: Number, url: String },
  status: { type: String, enum: ['pending', 'success', 'failed'], default: 'pending' },
  processingTime: { type: Number }, // in ms
  createdAt: { type: Date, default: Date.now, expires: 86400 * 7 } // auto-delete after 7 days
});

module.exports = mongoose.model('History', historySchema);
